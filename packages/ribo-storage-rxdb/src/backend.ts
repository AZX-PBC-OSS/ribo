import { map } from "rxjs";
import type { Observable } from "rxjs";
import type { MangoQuery, RxAttachmentCreator, RxCollection, RxDocument } from "rxdb";

import {
  CAPTURES_COLLECTION_NAME,
  PLUGIN_STORAGE_COLLECTION_NAME,
  SESSION_COLLECTION_NAME,
} from "@azx/ribo-core";
import type {
  BlobDescriptor,
  BlobInput,
  CollectionName,
  Finders,
  Modifier,
  StorageBackend,
  StoredDocument,
} from "@azx/ribo-core";

import type { OutboxDatabase } from "./database.js";
import { captureRxSchema, pluginStorageRxSchema, sessionRxSchema } from "./schemas.js";

/**
 * @file The RxDB implementation of the storage port.
 *
 * The first backend, and for now the production one. Everything RxDB-shaped
 * lives on this side of the port: Mango queries, attachments, incremental
 * modification, the metadata RxDB hangs off a document, and the schema versions.
 * Core knows none of it.
 *
 * What this file is *not* is a place for domain logic. If a method here starts
 * caring what `transcribing` means or which recordings belong to a session, it
 * has taken something that belongs in `@azx/ribo-core`'s store facades.
 */

/**
 * Logical collection name to the name on disk.
 *
 * The persisted names do not change, and this map is why they do not have to.
 * `captures` is stored in a collection called `storage` because renaming it would
 * be a migration on the one collection where a bad migration strands a real
 * auditor's recordings — and a rename buys nothing but tidiness.
 */
const PERSISTED: Record<CollectionName, string> = {
  captures: CAPTURES_COLLECTION_NAME,
  sessions: SESSION_COLLECTION_NAME,
  entries: PLUGIN_STORAGE_COLLECTION_NAME,
};

/**
 * The fields each collection actually persists, derived from its own schema.
 *
 * Derived rather than listed so it cannot drift: a field added to a schema is
 * carried through here with no second edit, and obligation 5 (documents come
 * back clean) keeps holding.
 */
const PERSISTED_FIELDS: Record<CollectionName, readonly string[]> = {
  captures: Object.keys(captureRxSchema.properties),
  sessions: Object.keys(sessionRxSchema.properties),
  entries: Object.keys(pluginStorageRxSchema.properties),
};

/**
 * Strip RxDB's own metadata.
 *
 * `incrementalModify` hands its modifier the *internal* document, carrying
 * `_rev`, `_meta`, `_deleted` and `_attachments`; core's document schemas are
 * `strictObject`, so a leaked key is a parse failure rather than a cosmetic
 * wart. Obligation 5 makes this the backend's job, which is why core no longer
 * carries `persistedFieldsOf`.
 */
function clean(collection: CollectionName, data: Record<string, unknown>): StoredDocument {
  const document: Record<string, unknown> = {};
  for (const field of PERSISTED_FIELDS[collection]) {
    if (field in data) document[field] = data[field];
  }
  return document as StoredDocument;
}

/** RxDB requires a non-empty content type; a hand-built Blob may carry none. */
function attachmentOf(blob: BlobInput): RxAttachmentCreator & { id: string } {
  return {
    id: blob.id,
    type: blob.data.type || "application/octet-stream",
    data: blob.data,
  };
}

/**
 * Serialise a section across every context sharing this origin.
 *
 * Web Locks queue (unlike `capture-lock.ts`'s `holdLock`, which is a *try*-lock
 * that reports "busy" rather than waiting — right for "which tab is recording",
 * wrong for allocating a sequence). Outside a browser there is no cross-context
 * anything to coordinate, so an in-process chain is the honest equivalent.
 *
 * **The fallback is for non-browser runtimes, not for old browsers.** In a
 * browser without `navigator.locks` it would silently restore the cross-tab race
 * obligation 6 exists to forbid. That is tolerable only because the repo's
 * browser floor already assumes Web Locks outright — `capture-lock.ts` calls
 * `navigator.locks` with no fallback at all, so such a browser cannot record in
 * the first place.
 */
const processChains = new Map<string, Promise<unknown>>();

async function withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(name, run);

  const previous = processChains.get(name) ?? Promise.resolve();
  const next = previous.then(run, run);
  processChains.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}

/** Build the Mango query for one finder. The only place a selector exists. */
function mangoFor<C extends CollectionName>(
  collection: C,
  finder: Finders[C],
): MangoQuery<Record<string, unknown>> {
  const selector: Record<string, unknown> = {};

  if (collection === "captures") {
    const query = finder as Finders["captures"];
    if (query.status) selector.status = { $in: [...query.status] };
    if (query.sessionId !== undefined) selector.sessionId = query.sessionId;
    return withSelector(selector, [{ seq: "asc" }], query.limit);
  }

  if (collection === "sessions") {
    const query = finder as Finders["sessions"];
    if (query.status) selector.status = { $in: [...query.status] };
    if (query.ref !== undefined) selector.ref = query.ref;
    return withSelector(selector, [{ openedAt: "asc" }], query.limit);
  }

  const query = finder as Finders["entries"];
  // A straight mapping since v1: the collection persists the scope kind, so the
  // port's vocabulary and the stored vocabulary are the same. The guard that
  // used to refuse a session scope is gone with the translation it protected.
  if (query.scopeKind !== undefined) selector.scopeKind = query.scopeKind;
  if (query.scopeId !== undefined) {
    selector.scopeId =
      typeof query.scopeId === "string" ? query.scopeId : { $in: [...query.scopeId] };
  }
  if (query.owner !== undefined) selector.owner = query.owner;
  return withSelector(selector, [{ key: "asc" }], query.limit);
}

function withSelector(
  selector: Record<string, unknown>,
  sort: Record<string, "asc">[],
  limit: number | undefined,
): MangoQuery<Record<string, unknown>> {
  return {
    // An empty `selector` is not the same as no selector to every RxDB query
    // planner, so the key is omitted entirely rather than left empty.
    ...(Object.keys(selector).length > 0 ? { selector } : {}),
    sort,
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * A storage backend that is known to be this one, and so can hand back the RxDB
 * database underneath it.
 *
 * The deliberate replacement for the old `Outbox.database` getter. That one lived
 * on core and made RxDB part of core's public surface for everyone; the escape
 * hatch now lives in the package that already owns RxDB, so a host reaches for it
 * knowingly and nobody else inherits the dependency.
 * @category Offline & Storage
 */
export interface RxdbStorageBackend extends StorageBackend {
  /** The database this backend reads and writes, for hosts adding their own collections. */
  readonly database: OutboxDatabase;
}

/**
 * Create a backend over an already-open RxDB database.
 *
 * @category Offline & Storage
 */
export function createRxdbBackend(database: OutboxDatabase, name: string): RxdbStorageBackend {
  return new RxdbBackend(database, name);
}

class RxdbBackend implements RxdbStorageBackend {
  readonly name: string;
  readonly #database: OutboxDatabase;

  constructor(database: OutboxDatabase, name: string) {
    this.#database = database;
    this.name = name;
  }

  get database(): OutboxDatabase {
    return this.#database;
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  async get(collection: CollectionName, id: string): Promise<StoredDocument | undefined> {
    const document = await this.#collection(collection).findOne(id).exec();
    return document ? this.#project(collection, document) : undefined;
  }

  async find<C extends CollectionName>(
    collection: C,
    finder: Finders[C],
  ): Promise<StoredDocument[]> {
    const documents = await this.#collection(collection).find(mangoFor(collection, finder)).exec();
    return documents.map((document) => this.#project(collection, document));
  }

  watch<C extends CollectionName>(collection: C, finder: Finders[C]): Observable<StoredDocument[]> {
    return this.#collection(collection)
      .find(mangoFor(collection, finder))
      .$.pipe(map((documents) => documents.map((document) => this.#project(collection, document))));
  }

  // -----------------------------------------------------------------------
  // Writes
  // -----------------------------------------------------------------------

  async insert(
    collection: CollectionName,
    document: StoredDocument,
    blobs?: readonly BlobInput[],
  ): Promise<StoredDocument> {
    // Obligation 1: the document and its blobs are ONE write. Passing the
    // attachments inline lets RxDB fold them into a single `bulkWrite`, which
    // Dexie runs as one IndexedDB transaction spanning both stores and only
    // publishes once committed. Writing them afterwards with `putAttachment`
    // would open a window where a subscriber sees a capture whose audio is not
    // there yet — which is the bug this obligation exists to prevent.
    const inserted = await this.#collection(collection).insert({
      ...this.#persist(collection, document),
      ...(blobs && blobs.length > 0 ? { _attachments: blobs.map(attachmentOf) } : {}),
    });
    return this.#project(collection, inserted);
  }

  async insertNext(
    collection: CollectionName,
    sequenceField: string,
    document: StoredDocument,
    blobs?: readonly BlobInput[],
  ): Promise<StoredDocument> {
    // Obligation 6. Read-highest-then-insert is a read-modify-write, and the
    // lock is what makes it atomic for every tab on this origin rather than
    // merely for this instance. The code this replaces serialised with an
    // in-process promise chain, so two tabs recording at once could claim the
    // same sequence.
    return withLock(`ribo-storage-seq:${this.name}:${collection}`, async () => {
      const highest = await this.#collection(collection)
        .findOne({ sort: [{ [sequenceField]: "desc" }] })
        .exec();
      // -1 when the collection is empty, so the first allocation is 0 — the
      // captures schema declares `minimum: 0` and existing devices are
      // zero-based.
      const previous = highest
        ? ((highest.toJSON() as Record<string, unknown>)[sequenceField] as number)
        : -1;
      return this.insert(collection, { ...document, [sequenceField]: previous + 1 }, blobs);
    });
  }

  async modify(
    collection: CollectionName,
    id: string,
    modifier: Modifier,
  ): Promise<StoredDocument> {
    const document = await this.#collection(collection).findOne(id).exec();
    if (!document) {
      throw new Error(`ribo-storage-rxdb: ${collection} has no document "${id}"`);
    }

    // `incrementalModify` re-runs the modifier on a write conflict, which is what
    // makes obligation 3 hold: two concurrent modifies of different fields both
    // land instead of the later clobbering the earlier.
    const updated = await document.incrementalModify((current) => {
      const next = this.#persist(collection, modifier(this.#cleanData(collection, current)));

      // Carry RxDB's own bookkeeping across — `_attachments` above all, since
      // dropping it would detach every blob on the document — but take every
      // *schema* field from the modifier's return rather than merging it over
      // `current`.
      //
      // The distinction is the whole point: a modifier "returns the next
      // document", so a key it omits must be gone. Merging over `current` makes
      // deletion impossible, and deletion is load-bearing — writing a transcript
      // removes the provisional `preview` by omission, in the same revision, so
      // that no subscriber ever sees final text beside stale provisional text.
      const internals: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) {
        if (key.startsWith("_")) internals[key] = value;
      }
      return { ...internals, ...next };
    });
    return this.#project(collection, updated);
  }

  async upsert(collection: CollectionName, document: StoredDocument): Promise<StoredDocument> {
    const upserted = await this.#collection(collection).incrementalUpsert(
      this.#persist(collection, document),
    );
    return this.#project(collection, upserted);
  }

  async remove(collection: CollectionName, id: string): Promise<boolean> {
    const document = await this.#collection(collection).findOne(id).exec();
    if (!document) return false;
    await document.remove();
    return true;
  }

  async removeMany(collection: CollectionName, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.#collection(collection).bulkRemove([...ids]);
    // `error` collects per-document failures, a 404 for an already-absent id
    // most commonly. Reporting the successes keeps the count honest.
    return result.success.length;
  }

  // -----------------------------------------------------------------------
  // Blobs
  // -----------------------------------------------------------------------

  async putBlob(collection: CollectionName, id: string, blobId: string, data: Blob): Promise<void> {
    const document = await this.#collection(collection).findOne(id).exec();
    if (!document) {
      throw new Error(
        `ribo-storage-rxdb: ${collection} has no document "${id}" to attach a blob to`,
      );
    }
    await document.putAttachment(attachmentOf({ id: blobId, data }));
  }

  async getBlob(collection: CollectionName, id: string, blobId: string): Promise<Blob | undefined> {
    const document = await this.#collection(collection).findOne(id).exec();
    const attachment = document?.getAttachment(blobId);
    return attachment ? await attachment.getData() : undefined;
  }

  async listBlobs(collection: CollectionName, id: string): Promise<BlobDescriptor[]> {
    const document = await this.#collection(collection).findOne(id).exec();
    if (!document) return [];
    // Obligation 4: stubs carry `length`, so this never touches the bytes. A
    // queue of recordings summed with `getData()` would be a memory bomb.
    return document.allAttachments().map((attachment) => ({
      id: attachment.id,
      length: attachment.length,
    }));
  }

  async listBlobsMany(
    collection: CollectionName,
    ids: readonly string[],
  ): Promise<Map<string, BlobDescriptor[]>> {
    if (ids.length === 0) return new Map();

    // One query for the whole set, then stubs off each document in memory —
    // `allAttachments()` reads `_data`, so this is a property walk and never
    // fetches bytes. That keeps the derived `audioBytes` cheap enough to compute
    // for every row of every emission, which is what it is used for.
    const documents = await this.#collection(collection)
      .find({ selector: { id: { $in: [...ids] } } })
      .exec();

    const result = new Map<string, BlobDescriptor[]>();
    for (const document of documents) {
      result.set(
        document.primary,
        document.allAttachments().map((attachment) => ({
          id: attachment.id,
          length: attachment.length,
        })),
      );
    }
    return result;
  }

  async removeBlob(collection: CollectionName, id: string, blobId: string): Promise<void> {
    const document = await this.#collection(collection).findOne(id).exec();
    await document?.getAttachment(blobId)?.remove();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    await this.#database.close();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #collection(collection: CollectionName): RxCollection<Record<string, unknown>> {
    return this.#database.collections[
      PERSISTED[collection] as keyof OutboxDatabase["collections"]
    ] as unknown as RxCollection<Record<string, unknown>>;
  }

  /** Persisted shape → the port's shape. */
  #project(
    collection: CollectionName,
    document: RxDocument<Record<string, unknown>>,
  ): StoredDocument {
    return this.#cleanData(collection, document.toJSON());
  }

  #cleanData(collection: CollectionName, data: Record<string, unknown>): StoredDocument {
    return clean(collection, data);
  }

  /** The port's shape → persisted shape. Identical since v1; kept as the seam's one name. */
  #persist(_collection: CollectionName, document: StoredDocument): Record<string, unknown> {
    return { ...document };
  }
}
