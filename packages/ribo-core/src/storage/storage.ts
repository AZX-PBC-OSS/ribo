import { CaptureStore } from "./captures.js";
import {
  createCaptureStore,
  createScopedStore,
  createStore,
  type CaptureStorageScope,
  type Store,
} from "./entries.js";
import { SessionStore } from "./sessions.js";
import type { PluginStorage } from "./plugin-storage.js";
import type { StorageBackend } from "./port.js";

/**
 * @file `Storage` — the container the whole subsystem hangs off.
 *
 * What used to be a single `Outbox` class over three collections is now three
 * stores with one owner each: captures, sessions, and whatever a host or plugin
 * declares. "Outbox" named a queue of recordings waiting to go out, which only
 * ever described the first of the three.
 *
 * The container itself does almost nothing — it opens a backend, builds the
 * stores over it, and closes it again. That is deliberate: the domain logic
 * belongs to the store that owns the concept, and a container with behaviour of
 * its own would be a fourth place to look.
 * @category Offline & Storage
 */

export interface OpenStorageOptions {
  /**
   * Where durable state lives — the backend every store reads and writes through.
   *
   * Required, and deliberately so: there is no default, because every default
   * would be wrong somewhere. `createMemoryBackend` for tests and development;
   * `openRxdbBackend` from `@azx/ribo-storage-rxdb` for a browser host, which is
   * the production path. This package does not depend on RxDB, so it could not
   * construct that one even if it wanted to.
   */
  backend: StorageBackend;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id source. Defaults to `crypto.randomUUID`. */
  createId?: () => string;
  /** Injectable idempotency-key source. Defaults to `crypto.randomUUID`. */
  createIdempotencyKey?: () => string;
}

/** Open storage over a backend. */
export async function openStorage(options: OpenStorageOptions): Promise<Storage> {
  return Promise.resolve(new Storage(options.backend, options));
}

/**
 * The three stores, and the backend they share.
 *
 * @category Offline & Storage
 */
export class Storage {
  /** Recordings and documents a device has captured, and their audio. */
  readonly captures: CaptureStore;
  /** Extraction, review and write-back state for a set of captures taken together. */
  readonly sessions: SessionStore;

  readonly #backend: StorageBackend;
  #closed = false;

  constructor(backend: StorageBackend, options: Omit<OpenStorageOptions, "backend"> = {}) {
    this.#backend = backend;
    const deps = {
      backend,
      now: options.now ?? ((): number => Date.now()),
      createId: options.createId ?? ((): string => crypto.randomUUID()),
      createIdempotencyKey: options.createIdempotencyKey ?? ((): string => crypto.randomUUID()),
    };
    this.captures = new CaptureStore(deps);
    this.sessions = new SessionStore(deps, this.captures);
  }

  /**
   * A namespaced store for one owner — a plugin, or the host itself.
   *
   * The first-class replacement for reaching through to the database and adding a
   * collection. A declared store is a namespace within the one `entries`
   * collection, so declaring one needs no schema, no migration and no cooperation
   * from the backend.
   *
   * The owner is conventionally a package name. Two owners that name themselves
   * differently cannot see each other's keys.
   */
  store(owner: string): Store {
    return createStore(this.#backend, owner);
  }

  /**
   * One capture's namespace for one owner, for a caller that already holds both.
   *
   * This is the shape the relay hands a transcriber: the relay knows the capture
   * but cannot know which engine a selection combinator will pick, so the capture
   * is fixed here and the owner is supplied by whoever receives it.
   */
  scopedStore(captureId: string, owner: string): PluginStorage {
    return createScopedStore(this.#backend, captureId, owner);
  }

  /**
   * One capture's namespace, with the owner yet to name itself.
   *
   * This is what the relay puts in `TranscribeOptions.storage`: it knows the
   * capture being transcribed but cannot know which engine a selection
   * combinator (`firstCapable`, `fallbackTranscriber`, `hedgedTranscriber`) will pick, so
   * the capture is fixed here and the owner is supplied by the transcriber — its
   * own `engine` id being the natural choice.
   */
  captureStore(captureId: string): CaptureStorageScope {
    return createCaptureStore(this.#backend, captureId);
  }

  /**
   * The backend this storage was opened over.
   *
   * Narrower than the `database` getter it replaces, which handed out an
   * `RxDatabase` and so made RxDB part of this package's public surface. A host
   * that wants its own RxDB collections gets the database from
   * `@azx/ribo-storage-rxdb`, deliberately, rather than inheriting a dependency
   * it never asked for by reaching through here.
   */
  get backend(): StorageBackend {
    return this.#backend;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Close the backend. Every store over it is unusable afterwards. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#backend.close();
  }
}
