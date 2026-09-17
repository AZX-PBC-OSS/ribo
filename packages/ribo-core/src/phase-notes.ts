/**
 * @file Branded note keys and the immutable cross-phase bag they address.
 *
 * The phase draft's `notes` is the cross-phase channel — how one phase hands structured
 * scratch data (a roster, a per-group presence map) to a later phase. An untyped
 * `Record<string, unknown>` bag has three failure modes this file closes: two producers
 * of the same key silently clobber, a reader casts a key's value to the wrong shape, and
 * nothing names which phase owns which key. A note key is therefore branded with the type
 * it addresses, and the bag's `get`/`set` are generic in the key's type, so a mismatch is
 * a compile error rather than a field-time surprise.
 *
 * **The brand's type is a function, `(value: T) => T`, and that is load-bearing.** A bare
 * `{ readonly [NoteBrand]?: T }` would make `NoteKey<T>` covariant in `T` — a
 * `NoteKey<Roster>` would be assignable to a `NoteKey<unknown>` slot and the wrong-type
 * read this exists to prevent would typecheck. A function type puts `T` in both input and
 * output position, making it invariant under `strictFunctionTypes`. The brand is also
 * declared as a property with an arrow type, never a method signature: method syntax is
 * checked bivariantly, which would silently defeat the invariance.
 *
 * **The key is a plain string at runtime.** `requires`/`produces` are string arrays, the
 * phase-list construction check compares them as strings, and a later planner emits them
 * as JSON. The brand is a compile-time phantom only — `noteKey` is a cast and nothing
 * else, and `keys` returns plain strings.
 *
 * What this deliberately does not do: no `delete`, no value iteration, and no `merge` —
 * the bag is copied on `set` and every write to the draft's copy belongs to a phase's
 * `merge`, which owns every write (see `phase-draft.ts`). The bag is small (a handful of
 * keys per run), so copying on write is the right trade.
 */

/** The module-private symbol the brand lives under. Phantom only — erased at runtime. */
declare const NoteBrand: unique symbol;

/**
 * A string key branded with the type of the value it addresses.
 *
 * Invariant in `T` (see the file header for why the brand is a function type), so a
 * `NoteKey<Roster>` is not assignable to a `NoteKey<PresenceMap>` slot even though both
 * are plain strings at runtime. `noteKey<unknown>(id)` is the escape hatch: an open
 * scratch key that round-trips any value.
 */
export type NoteKey<T> = string & { readonly [NoteBrand]?: (value: T) => T };

/**
 * Brand a plain string id as a {@link NoteKey} for values of type `T`.
 *
 * The key is a plain string at runtime and the brand is a compile-time phantom, so there
 * is nothing to construct — and because the brand property is optional under a
 * module-private symbol, a plain `string` is directly assignable to the branded
 * intersection: no cast, even though semantically this is "a cast and nothing else".
 */
export function noteKey<T>(id: string): NoteKey<T> {
  return id;
}

/**
 * The immutable bag a phase's draft carries: typed reads and writes, structural sharing
 * by copy-on-set.
 *
 * `get` and `set` are generic in the KEY's type parameter, so the value's type follows the
 * key — a mismatched read or write is a compile error. `keys` is the plain-string view the
 * `requires`/`produces` declarations and the construction check speak.
 */
export interface Notes {
  /** The value stored under `key`, or `undefined` when nothing was set. */
  get: <T>(key: NoteKey<T>) => T | undefined;
  /** A new bag with `value` installed under `key`; the receiver is left unchanged. */
  set: <T>(key: NoteKey<T>, value: T) => Notes;
  /** The plain string ids of everything set, in insertion order. */
  readonly keys: readonly string[];
}

class NoteBag implements Notes {
  readonly #entries: ReadonlyMap<string, unknown>;

  constructor(entries: ReadonlyMap<string, unknown>) {
    this.#entries = entries;
  }

  get<T>(key: NoteKey<T>): T | undefined {
    // The runtime mirror of noteKey's cast, and the one narrowing the bag needs: a
    // `NoteKey<T>` only comes from `noteKey<T>(id)`, and `set` refuses any value that is
    // not a `T` under it, so a value found under this key was written at `T` by
    // construction. Recovering a `T` from an untyped map otherwise has no cast-free
    // spelling — this assertion asserts exactly what the brand guarantees.
    return this.#entries.get(key) as T | undefined;
  }

  set<T>(key: NoteKey<T>, value: T): Notes {
    return new NoteBag(new Map(this.#entries).set(key, value));
  }

  get keys(): readonly string[] {
    return [...this.#entries.keys()];
  }
}

/** The empty bag every draft starts with. */
export function emptyNotes(): Notes {
  return new NoteBag(new Map());
}
