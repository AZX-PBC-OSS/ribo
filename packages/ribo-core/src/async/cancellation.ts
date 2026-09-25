/**
 * @file The cancellation marker `ribo-core` can recognise without importing a transport's
 * error type.
 *
 * The discriminator has to work on an error constructed outside this module: `ChatError`
 * (the chat seam's own, in core since the seam moved here) already extends `Error` and cannot
 * also extend a second base class, and a transport's injected `fetch` can reject with error
 * types no package of ours declares at all. A branded property is the only mechanism that
 * lets any of them opt in without a shared base class. A combinator in core consults
 * {@link isCancellation} instead of an `instanceof` against a class it cannot name.
 *
 * What this deliberately does NOT do: change `isTransientFailure`, or decide for the relay
 * whether a cancelled extraction step is retryable. Those are a different layer's question
 * (`extraction-common.ts`'s "aborted is deliberately left retryable"); this module only
 * answers "is this error a cancellation?" — the in-run retry loop's question.
 */

/**
 * The brand: any error may carry this as a **truthy own property** to declare itself a
 * cancellation.
 *
 * A `unique symbol` so the property cannot be coined by accident or forged with a string
 * key, and so a TypeScript author can declare it on their own class without reaching for
 * `any`. Truthy, not merely present: `useDefineForClassFields` puts an own
 * `[CANCELLATION]: undefined` on every instance of a class that merely declares the field,
 * and that instance is not a cancellation.
 */
export const CANCELLATION: unique symbol = Symbol("ribo.cancellation");

/**
 * The shape an error carries the brand with. Declared so a TypeScript producer can set the
 * property without a cast:
 *
 * ```ts
 * const error = new Error("gave up") as Error & CancellationBranded;
 * error[CANCELLATION] = true;
 * ```
 *
 * The member is optional and **not** `readonly` — a `readonly` declaration makes the
 * factory assignment fail with TS2540.
 */
export interface CancellationBranded {
  [CANCELLATION]?: true;
}

/**
 * Core's own cancellation error, carrying the brand.
 *
 * The member is `declare`d rather than field-declared: under `useDefineForClassFields`
 * a field declaration would define an own `[CANCELLATION]: undefined` before the
 * constructor body ran — the exact not-really-branded case {@link isCancellation} must
 * reject. Declare + assign emits no definition and lands a truthy own property.
 */
export class CancellationError extends Error implements CancellationBranded {
  override readonly name = "CancellationError";
  declare [CANCELLATION]?: true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this[CANCELLATION] = true;
  }
}

/**
 * Is this error a cancellation? Never throws, for any input.
 *
 * Checks, in order:
 *
 * 1. The passed signal's `aborted` flag, when a signal was given — the caller's own
 *    cancel is authoritative over anything the error claims.
 * 2. A truthy `[CANCELLATION]` **own** property on a non-null object — the foreign
 *    transport's opt-in. Own, not `in`: a prototype walk has no benefit here (brands are
 *    set per-instance in a factory, never on a prototype) and widens the surface where a
 *    trap can fire.
 * 3. An error whose `name` is `"AbortError"` — the native case. Duck-checked, not
 *    `instanceof DOMException`: a `DOMException` crossing a realm boundary (iframe,
 *    worker) fails `instanceof` against the local constructor, and a worker boundary is
 *    exactly where this repo's on-device transport lives.
 *
 * The entire body sits in a `try`/`catch` because this predicate runs inside `catch`
 * blocks, where throwing would destroy the error being handled — and a `try`/null-guard
 * is not enough: a property read on a `Proxy` invokes its traps and
 * `Object.prototype.hasOwnProperty.call` invokes `getOwnPropertyDescriptor`, so any of
 * those can throw for arbitrary input. The catch is the only construct that actually
 * delivers "never throws".
 */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  try {
    if (signal?.aborted) return true;
    if (typeof error !== "object" || error === null) return false;
    if (Object.prototype.hasOwnProperty.call(error, CANCELLATION)) {
      if ((error as CancellationBranded)[CANCELLATION]) return true;
    }
    if ((error as { name?: unknown }).name === "AbortError") return true;
    return false;
  } catch {
    return false;
  }
}
