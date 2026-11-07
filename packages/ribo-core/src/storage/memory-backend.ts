import { Subject, from, startWith, switchMap } from "rxjs";
import type { Observable } from "rxjs";

import type {
  BlobDescriptor,
  BlobInput,
  CollectionName,
  Finders,
  Modifier,
  StorageBackend,
  StoredDocument,
} from "./port.js";

/**
 * @file An in-memory implementation of the storage port.
 *
 * Two jobs, and the second is the important one:
 *
 * 1. It is the fast backend for node tests and for development, so the domain
 *    logic's suite no longer needs a browser or an IndexedDB shim.
 * 2. It is the standing proof that `@azx/ribo-core` has no RxDB dependency. A
 *    port with one implementation is a guess; this is the second implementation,
 *    and it passes the same conformance kit.
 *
 * "In memory" does not mean "not durable". Databases live in a process-wide
 * registry keyed by name, so two handles opened on one name share state and a
 * close-and-reopen sees what was written — which is what the port's
 * cross-context obligation actually requires. A backend whose `createBackend`
 * returned an isolated map would pass that test vacuously.
 */

interface MemoryDatabase {
  readonly documents: Map<CollectionName, Map<string, StoredDocument>>;
  /** Blobs by collection, then by document id, then by blob id. */
  readonly blobs: Map<CollectionName, Map<string, Map<string, Blob>>>;
  /** Fires after any write commits; `watch` re-runs its finder on it. */
  readonly changes: Subject<void>;
  /** Serialises read-modify-write per document, so concurrent modifies cannot clobber. */
  readonly modifyChains: Map<string, Promise<unknown>>;
  /** Serialises sequence allocation across every handle on this database. */
  sequenceChain: Promise<unknown>;
}

const COLLECTIONS: readonly CollectionName[] = ["captures", "sessions", "entries"];

/**
 * Every memory database in this process, by name.
 *
 * Module scope is deliberate here and is the opposite of the usual advice: it is
 * precisely what makes two handles on one name the same database, which is the
 * shape a durable backend has and the thing obligation 2 tests.
 */
const databases = new Map<string, MemoryDatabase>();

function databaseFor(name: string): MemoryDatabase {
  const existing = databases.get(name);
  if (existing) return existing;

  const documents = new Map<CollectionName, Map<string, StoredDocument>>();
  const blobs = new Map<CollectionName, Map<string, Map<string, Blob>>>();
  for (const collection of COLLECTIONS) {
    documents.set(collection, new Map());
    blobs.set(collection, new Map());
  }

  const created: MemoryDatabase = {
    documents,
    blobs,
    changes: new Subject(),
    modifyChains: new Map(),
    sequenceChain: Promise.resolve(),
  };
  databases.set(name, created);
  return created;
}

/**
 * Discard a memory database entirely.
 *
 * The analogue of removing an IndexedDB database. Tests that want a guaranteed
 * cold start use it; nothing else should.
 * @category Offline & Storage
 */
export function removeMemoryDatabase(name: string): void {
  databases.delete(name);
}

/**
 * Open an in-memory backend. Two calls with the same name share one database.
 *
 * @category Offline & Storage
 */
export function createMemoryBackend(name: string): StorageBackend {
  return new MemoryBackend(name);
}

/** Documents are cloned on the way out so a caller cannot mutate stored state. */
function copy(document: StoredDocument): StoredDocument {
  return structuredClone(document);
}

/**
 * Code-unit order, which is what JS's bare `.sort()` does and what the port pins.
 * `localeCompare` folds case and would disagree on exactly the keys a plugin is
 * most likely to write.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesStatus(document: StoredDocument, status: readonly string[] | undefined): boolean {
  if (status === undefined) return true;
  return status.includes(document.status as string);
}

class MemoryBackend implements StorageBackend {
  readonly name: string;
  readonly #database: MemoryDatabase;
  #closed = false;

  constructor(name: string) {
    this.name = name;
    this.#database = databaseFor(name);
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  async get(collection: CollectionName, id: string): Promise<StoredDocument | undefined> {
    this.#assertOpen();
    const document = this.#documents(collection).get(id);
    return document === undefined ? undefined : copy(document);
  }

  async find<C extends CollectionName>(
    collection: C,
    finder: Finders[C],
  ): Promise<StoredDocument[]> {
    this.#assertOpen();
    return this.#query(collection, finder);
  }

  watch<C extends CollectionName>(collection: C, finder: Finders[C]): Observable<StoredDocument[]> {
    this.#assertOpen();
    return this.#database.changes.pipe(
      startWith(undefined),
      switchMap(() => from(Promise.resolve(this.#query(collection, finder)))),
    );
  }

  /**
   * The three finders, and the only place this backend knows what a collection's
   * fields mean. Each sorts before limiting, so a limit is the first N in the
   * finder's declared order rather than the first N found.
   */
  #query<C extends CollectionName>(collection: C, finder: Finders[C]): StoredDocument[] {
    const all = [...this.#documents(collection).values()];

    if (collection === "captures") {
      const query = finder as Finders["captures"];
      const matched = all.filter(
        (document) =>
          matchesStatus(document, query.status) &&
          (query.sessionId === undefined || document.sessionId === query.sessionId),
      );
      matched.sort((a, b) => (a.seq as number) - (b.seq as number));
      return this.#take(matched, query.limit);
    }

    if (collection === "sessions") {
      const query = finder as Finders["sessions"];
      const matched = all.filter(
        (document) =>
          matchesStatus(document, query.status) &&
          (query.ref === undefined || document.ref === query.ref),
      );
      matched.sort((a, b) => byCodeUnit(String(a.openedAt), String(b.openedAt)));
      return this.#take(matched, query.limit);
    }

    const query = finder as Finders["entries"];
    const scopeIds =
      query.scopeId === undefined
        ? undefined
        : new Set(typeof query.scopeId === "string" ? [query.scopeId] : query.scopeId);
    const matched = all.filter(
      (document) =>
        (query.scopeKind === undefined || document.scopeKind === query.scopeKind) &&
        (scopeIds === undefined || scopeIds.has(document.scopeId as string)) &&
        (query.owner === undefined || document.owner === query.owner),
    );
    matched.sort((a, b) => byCodeUnit(String(a.key), String(b.key)));
    return this.#take(matched, query.limit);
  }

  #take(documents: StoredDocument[], limit: number | undefined): StoredDocument[] {
    const bounded = limit === undefined ? documents : documents.slice(0, limit);
    return bounded.map(copy);
  }

  // -----------------------------------------------------------------------
  // Writes
  // -----------------------------------------------------------------------

  async insert(
    collection: CollectionName,
    document: StoredDocument,
    blobs?: readonly BlobInput[],
  ): Promise<StoredDocument> {
    this.#assertOpen();
    if (this.#documents(collection).has(document.id)) {
      throw new Error(`memory backend: ${collection} already has a document "${document.id}"`);
    }
    return this.#commitInsert(collection, document, blobs);
  }

  async insertNext(
    collection: CollectionName,
    sequenceField: string,
    document: StoredDocument,
    blobs?: readonly BlobInput[],
  ): Promise<StoredDocument> {
    this.#assertOpen();

    // Obligation 6. Reading the highest value and inserting its successor is a
    // read-modify-write, so without this chain two concurrent callers both read
    // the same maximum and both claim it. The chain lives on the *database*, not
    // on the handle, so handles opened separately on one name still serialise.
    const next = this.#database.sequenceChain.then(
      () => this.#allocateAndInsert(collection, sequenceField, document, blobs),
      () => this.#allocateAndInsert(collection, sequenceField, document, blobs),
    );
    this.#database.sequenceChain = next.catch(() => undefined);
    return next;
  }

  async #allocateAndInsert(
    collection: CollectionName,
    sequenceField: string,
    document: StoredDocument,
    blobs: readonly BlobInput[] | undefined,
  ): Promise<StoredDocument> {
    // -1 so the first allocation is 0. The captures schema declares
    // `minimum: 0` and every device already holds zero-based rows, so counting
    // from one would both violate the schema and renumber history.
    let highest = -1;
    for (const stored of this.#documents(collection).values()) {
      const value = stored[sequenceField];
      if (typeof value === "number" && value > highest) highest = value;
    }
    return this.#commitInsert(collection, { ...document, [sequenceField]: highest + 1 }, blobs);
  }

  /**
   * The single write. Document and blobs land together and the change is
   * published only afterwards, so obligation 1 holds: no subscriber can observe
   * a document whose blob is not yet readable.
   */
  #commitInsert(
    collection: CollectionName,
    document: StoredDocument,
    blobs: readonly BlobInput[] | undefined,
  ): StoredDocument {
    const stored = copy(document);
    this.#documents(collection).set(stored.id, stored);

    if (blobs) {
      for (const blob of blobs) this.#blobsFor(collection, stored.id).set(blob.id, blob.data);
    }

    this.#database.changes.next();
    return copy(stored);
  }

  async modify(
    collection: CollectionName,
    id: string,
    modifier: Modifier,
  ): Promise<StoredDocument> {
    this.#assertOpen();

    // Obligation 3. The modifier may be async-adjacent and callers run these
    // concurrently, so each document gets its own chain: two modifies of
    // different fields both survive instead of the second clobbering the first.
    const key = `${collection}:${id}`;
    const chain = this.#database.modifyChains.get(key) ?? Promise.resolve();
    const next = chain.then(
      () => this.#applyModify(collection, id, modifier),
      () => this.#applyModify(collection, id, modifier),
    );
    this.#database.modifyChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  #applyModify(collection: CollectionName, id: string, modifier: Modifier): StoredDocument {
    const current = this.#documents(collection).get(id);
    if (current === undefined) {
      throw new Error(`memory backend: ${collection} has no document "${id}"`);
    }

    const updated = copy(modifier(copy(current)));
    if (updated.id !== id) {
      throw new Error(`memory backend: a modifier may not change the id of "${id}"`);
    }

    this.#documents(collection).set(id, updated);
    this.#database.changes.next();
    return copy(updated);
  }

  async upsert(collection: CollectionName, document: StoredDocument): Promise<StoredDocument> {
    this.#assertOpen();
    const stored = copy(document);
    this.#documents(collection).set(stored.id, stored);
    this.#database.changes.next();
    return copy(stored);
  }

  async remove(collection: CollectionName, id: string): Promise<boolean> {
    this.#assertOpen();
    const existed = this.#documents(collection).delete(id);
    this.#forget(collection, id);
    if (existed) this.#database.changes.next();
    return existed;
  }

  async removeMany(collection: CollectionName, ids: readonly string[]): Promise<number> {
    this.#assertOpen();
    let removed = 0;
    for (const id of ids) {
      if (this.#documents(collection).delete(id)) removed += 1;
      this.#forget(collection, id);
    }
    if (removed > 0) this.#database.changes.next();
    return removed;
  }

  /**
   * Drop everything keyed by a document that has gone.
   *
   * `modifyChains` would otherwise grow for the life of the database: a long
   * session that enqueues and clears repeatedly accumulates one settled promise
   * per id it has ever touched, and nothing ever reads them again.
   */
  #forget(collection: CollectionName, id: string): void {
    this.#blobRoot(collection).delete(id);
    this.#database.modifyChains.delete(`${collection}:${id}`);
  }

  // -----------------------------------------------------------------------
  // Blobs
  // -----------------------------------------------------------------------

  async putBlob(collection: CollectionName, id: string, blobId: string, data: Blob): Promise<void> {
    this.#assertOpen();
    // Refusing an orphan is part of the contract, not a nicety: lazily creating a
    // blob map for an unknown document writes bytes nothing will ever read and no
    // sweep knows about. RxDB refuses this by construction; so does this.
    if (!this.#documents(collection).has(id)) {
      throw new Error(`memory backend: ${collection} has no document "${id}" to attach a blob to`);
    }
    this.#blobsFor(collection, id).set(blobId, data);
    this.#database.changes.next();
  }

  async getBlob(collection: CollectionName, id: string, blobId: string): Promise<Blob | undefined> {
    this.#assertOpen();
    return this.#blobRoot(collection).get(id)?.get(blobId);
  }

  async listBlobs(collection: CollectionName, id: string): Promise<BlobDescriptor[]> {
    this.#assertOpen();
    const blobs = this.#blobRoot(collection).get(id);
    if (!blobs) return [];

    // Obligation 4: ids and lengths only. `size` rather than reading the bytes,
    // for the same reason RxDB reads attachment stubs — `audioBytes` sums these
    // across a whole queue.
    return [...blobs.entries()].map(([blobId, data]) => ({ id: blobId, length: data.size }));
  }

  async listBlobsMany(
    collection: CollectionName,
    ids: readonly string[],
  ): Promise<Map<string, BlobDescriptor[]>> {
    const root = this.#blobRoot(collection);
    const result = new Map<string, BlobDescriptor[]>();
    for (const id of ids) {
      // Presence is decided by the DOCUMENT, not by the blob map: a document that
      // exists and has no blobs maps to an empty list, and only a document that
      // is not there is absent from the result. Deciding it from the blob map
      // would conflate the two, and the caller uses exactly that distinction to
      // tell "no audio yet" from "this capture is gone".
      if (!this.#documents(collection).has(id)) continue;
      const blobs = root.get(id);
      result.set(
        id,
        blobs === undefined
          ? []
          : [...blobs.entries()].map(([blobId, data]) => ({ id: blobId, length: data.size })),
      );
    }
    return result;
  }

  async removeBlob(collection: CollectionName, id: string, blobId: string): Promise<void> {
    this.#assertOpen();
    if (this.#blobRoot(collection).get(id)?.delete(blobId)) this.#database.changes.next();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    // The data outlives the handle, exactly as a closed IndexedDB database's does.
    // Only this handle becomes unusable.
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`memory backend: "${this.name}" is closed`);
  }

  #documents(collection: CollectionName): Map<string, StoredDocument> {
    return this.#database.documents.get(collection)!;
  }

  #blobRoot(collection: CollectionName): Map<string, Map<string, Blob>> {
    return this.#database.blobs.get(collection)!;
  }

  #blobsFor(collection: CollectionName, id: string): Map<string, Blob> {
    const root = this.#blobRoot(collection);
    const existing = root.get(id);
    if (existing) return existing;

    const created = new Map<string, Blob>();
    root.set(id, created);
    return created;
  }
}
