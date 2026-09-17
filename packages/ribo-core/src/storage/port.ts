import type { Observable } from "rxjs";

/**
 * @file The storage port — the contract a backend implements.
 *
 * Deliberately mechanical. It addresses three collections by name and knows how
 * to move documents and blobs in and out of them. It does not know what a status
 * means, which field carries a sequence, or that sessions and captures are
 * related — all of that lives in the store facades above it.
 *
 * The design is `docs/roadmap/design/storage-port-design.md` §4. Read it before
 * widening this interface: the finders are a *closed set* on purpose, and the
 * obligations in {@link runStorageConformance} are as much a part of the contract
 * as the signatures here.
 */

/**
 * The three collections, by their logical names.
 *
 * These are not the persisted names. The RxDB backend maps `captures` onto the
 * on-disk `outbox` collection, because renaming a collection is a migration on
 * the one place where migrations strand real recordings. A backend is free to
 * store them wherever it likes under whatever names it likes.
 *
 * Three is the whole set, and it does not grow when a host declares a store: a
 * declared store is a namespace *within* `entries`, distinguished by its
 * `owner`, so a backend never learns how many stores exist.
 */
export type CollectionName = keyof Finders;

/** What a stored document looks like to the port: JSON-ish, with a string `id`. */
export type StoredDocument = Record<string, unknown> & { id: string };

/**
 * One blob attached to a document — its id and its size, never its bytes.
 *
 * The absence of a `data` field is load-bearing. `Capture.audioBytes` sums these
 * lengths across a whole queue, and a backend that materialised blobs to answer
 * would exhaust memory on a device holding a morning's dictations.
 */
export interface BlobDescriptor {
  readonly id: string;
  readonly length: number;
}

/**
 * The closed finder set.
 *
 * Three questions is all the domain logic asks, so the port names exactly three
 * and a backend indexes them however it likes. This is what stops the contract
 * from becoming a database: there is no selector language to specify, no sort
 * spec crossing the boundary, and no way for a caller to express a query a
 * backend cannot serve.
 *
 * **String ordering is code-unit order** — what a bare `.sort()` does — not
 * locale collation. The two differ on case, and pinning it matters because the
 * backend now owns a sort the domain logic used to do for itself.
 *
 * **There is deliberately no "highest sequence" finder.** Ascending-with-limit
 * gives the lowest, and the only caller that ever wanted the highest was
 * allocating the next one — which is {@link StorageBackend.insertNext}'s job
 * precisely so no caller has to read-then-write. If you find yourself wanting to
 * add one, you are probably reintroducing the race.
 */
export interface Finders {
  /** Captures, ordered by sequence ascending. */
  captures: {
    /** Match any of these statuses. Omitted means every status. */
    status?: readonly string[];
    sessionId?: string;
    limit?: number;
  };
  /** Sessions, ordered by opened-at ascending. */
  sessions: {
    status?: readonly string[];
    ref?: string;
    limit?: number;
  };
  /** Key-value entries, ordered by key ascending. */
  entries: {
    scopeKind?: EntryScopeKind;
    /**
     * Match one scope, or any of several.
     *
     * The set form is not a convenience — it is what the **sweep** needs. When a
     * batch of captures is removed, every entry belonging to any of them has to
     * go, and doing that one scope at a time turns one query into one per
     * capture on the "reset this device" path. A set here mirrors `status` on
     * the other two finders, so it adds no new *kind* of filter and every
     * backend can serve it (`IN`, `$in`, or a JS membership test).
     */
    scopeId?: string | readonly string[];
    owner?: string;
    limit?: number;
  };
}

/** What a key-value entry is scoped to, and therefore what sweeps it. */
export type EntryScopeKind = "capture" | "session";

/** A conflict-safe read-modify-write. Receives the current document, returns the next one. */
export type Modifier = (current: StoredDocument) => StoredDocument;

/** A blob to attach in the same write as its document. */
export interface BlobInput {
  readonly id: string;
  readonly data: Blob;
}

/**
 * The contract.
 *
 * Every method's *behavioural* obligations are specified by the conformance kit
 * rather than by these signatures — a backend that satisfies the types and fails
 * the kit is not an implementation of this port. See `conformance.ts`.
 */
export interface StorageBackend {
  /** The database name this backend was opened on. Two handles on one name share state. */
  readonly name: string;

  /** One document by id, or `undefined` if it is not there. */
  get: (collection: CollectionName, id: string) => Promise<StoredDocument | undefined>;

  /** Run a finder. */
  find: <C extends CollectionName>(collection: C, finder: Finders[C]) => Promise<StoredDocument[]>;

  /**
   * Subscribe to a finder. Emits the current result set on subscribe and again on
   * every change that affects it — including changes made through a *different*
   * backend handle on the same database.
   */
  watch: <C extends CollectionName>(
    collection: C,
    finder: Finders[C],
  ) => Observable<StoredDocument[]>;

  /**
   * Insert a document, optionally with blobs attached in the **same write**.
   *
   * There must be no observable moment where {@link watch} has published the
   * document and {@link getBlob} answers `undefined` for a blob passed here.
   */
  insert: (
    collection: CollectionName,
    document: StoredDocument,
    blobs?: readonly BlobInput[],
  ) => Promise<StoredDocument>;

  /**
   * Insert a document, assigning the next value of a monotonic integer field.
   *
   * The allocation must be atomic across every context sharing the database, not
   * merely within this handle. The port takes the field's *name* rather than
   * knowing which field it is, so it learns the concept without learning the
   * schema.
   *
   * **The first value allocated into an empty collection is 0.**
   *
   * This exists because read-highest-then-insert is a race that a backend can
   * close for free — with a lock in the browser, or an autoincrement column in a
   * SQL store — and that core cannot close at all.
   */
  insertNext: (
    collection: CollectionName,
    sequenceField: string,
    document: Omit<StoredDocument, "id"> & { id: string },
    blobs?: readonly BlobInput[],
  ) => Promise<StoredDocument>;

  /**
   * Conflict-safe read-modify-write. Concurrent modifies must not lose an update:
   * if two callers each change a different field, both changes survive.
   */
  modify: (collection: CollectionName, id: string, modifier: Modifier) => Promise<StoredDocument>;

  /** Insert or replace by primary key. */
  upsert: (collection: CollectionName, document: StoredDocument) => Promise<StoredDocument>;

  /** Remove one document and its blobs. Resolves `false` if it was not there. */
  remove: (collection: CollectionName, id: string) => Promise<boolean>;

  /** Remove many. Ids that are absent are skipped; resolves how many actually went. */
  removeMany: (collection: CollectionName, ids: readonly string[]) => Promise<number>;

  /**
   * Attach a blob to an existing document, replacing any blob with the same id.
   *
   * **Rejects if the document does not exist.** Stated because backends disagree
   * by default — an attachment store keyed by document id will happily create an
   * orphan, while RxDB refuses without a document to hang it on. Silently
   * accepting is the worse default: the bytes are written, nothing ever reads
   * them, and no sweep knows they are there.
   */
  putBlob: (collection: CollectionName, id: string, blobId: string, data: Blob) => Promise<void>;

  /** One blob's bytes, or `undefined` if absent. */
  getBlob: (collection: CollectionName, id: string, blobId: string) => Promise<Blob | undefined>;

  /** Every blob on a document — ids and lengths, never bytes. */
  listBlobs: (collection: CollectionName, id: string) => Promise<BlobDescriptor[]>;

  /**
   * {@link listBlobs} for many documents at once, keyed by document id.
   *
   * Exists because a capture's `audioReady` and `audioBytes` are derived from
   * its blobs, and they are derived for **every row in a query result** — so the
   * per-document form would mean one round trip per row on every repaint of the
   * queue. Ids absent from storage are simply absent from the result.
   *
   * A backend that can answer this from the documents it has just read should:
   * the previous implementation got these facts from in-memory attachment stubs
   * with no I/O at all, and that is the bar.
   */
  listBlobsMany: (
    collection: CollectionName,
    ids: readonly string[],
  ) => Promise<Map<string, BlobDescriptor[]>>;

  /** Detach one blob. Silently succeeds if it is not there. */
  removeBlob: (collection: CollectionName, id: string, blobId: string) => Promise<void>;

  /** Close the backend. Handles are unusable afterwards. */
  close: () => Promise<void>;
}
