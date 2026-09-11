import { TerminalQueueError } from "./queue/backoff.js";

/**
 * @file The third failure class: _item unsuitability_.
 *
 * Ribo has two failure kinds, and a scanned PDF is neither:
 *
 * - **Attempt failure** — this clip OOMed, this inference threw, this request
 *   503'd. Retry it: the queue's backoff and `maxAttempts` already do the right
 *   thing. One bad clip must never demote an engine.
 * - **Capability failure** — the runtime would not init, the weights will not
 *   load, this device cannot do this. Throw {@link TranscriberUnavailableError}:
 *   falling back is correct and the earlier `capability()` answer was wrong.
 *
 * A scanned PDF with no text layer is neither. pdf.js is working perfectly, so
 * demoting it is wrong; retrying pdf.js will never help, so burning eight
 * backed-off attempts is waste. This is _item unsuitability_ — "this engine
 * cannot handle this item, and that says nothing about the engine". The correct
 * response is to try the next engine (e.g. OCR), not to retry this one.
 *
 * ## Why "Unsupported" and not "Untranscribable"
 *
 * "Untranscribable" is a claim about the _item_, and it is false: a scanned PDF
 * is perfectly transcribable — by OCR. A name that overstates the verdict
 * invites the wrong handling one layer up ("nothing can read this, give up")
 * when the correct handling is "this engine cannot, try the next one".
 * "Unsupported" is inherently relative to a _supporter_, and the supporter is
 * named in the error's own {@link UnsupportedItemError.engine | engine} field.
 *
 * ## Relationship to `unsupported-platform`
 *
 * The vocabulary echoes `unsupported-platform` (a
 * {@link TranscriberUnavailableReason}), which is a _capability_ reason: the
 * device cannot run this engine at all. This class is the opposite: the engine
 * is fine, the _item_ is the wrong kind for it. The suffix nouns keep them
 * apart (`-Platform` versus `-Item`), and the reason vocabulary reinforces it:
 * `no-text-layer`, `encrypted` and `unsupported-format` are all plainly
 * properties of an item, not a device.
 *
 * ## Terminal for this engine+item pair
 *
 * Extends {@link TerminalQueueError} so `isTransientFailure` classifies it as
 * non-retryable: a relay retry _is_ retrying the same engine on the same item,
 * so without this a bare pdf.js transcriber handed a scanned PDF burns eight
 * backed-off attempts over ~10 minutes before landing in `dead`. The error is
 * terminal for the queue but not for the item — a composition layer (Task 4's
 * `fallbackTranscriber`) routes to the next engine, which is the whole point.
 *
 * Contrast {@link TranscriberUnavailableError}, which is deliberately _not_
 * terminal: the next attempt re-probes and may route to a different engine
 * entirely. The two sit on opposite sides of that line on purpose.
 */

/**
 * The closed set of reasons an engine cannot handle an item.
 *
 * A UI has to branch on this, and free-text reasons make that impossible.
 * `detail` is required so a reason code never has to carry nuance it cannot
 * express.
 */
export const UNSUPPORTED_ITEM_REASONS = [
  /** The document has no extractable text — a scanned PDF with no OCR layer. */
  "no-text-layer",
  /** The document is password-protected and no password was supplied. */
  "encrypted",
  /** The bytes are not a document this engine can read at all. */
  "unsupported-format",
] as const;

export type UnsupportedItemReason = (typeof UNSUPPORTED_ITEM_REASONS)[number];

export interface UnsupportedItemInit {
  /** The engine that cannot handle this item — `Transcriber.engine`. */
  engine: string;
  reason: UnsupportedItemReason;
  /** Human-readable specifics. Required — a reason code with no detail is unactionable. */
  detail: string;
  /** Underlying failure, if there was one. */
  cause?: unknown;
}

/**
 * "This engine cannot handle this item" — _item unsuitability_, the third
 * failure class.
 *
 * See the {@link ./unsupported-item.ts | module doc} for the distinction from
 * attempt failure and capability failure, and for why the name is
 * "Unsupported" rather than "Untranscribable".
 *
 * Deliberately carries **no** `capability` accessor (contrast
 * {@link TranscriberUnavailableError.capability}): the one thing this class
 * must never do is offer a capability verdict to replace a cached one, because
 * the engine stays `ready` — pdf.js can read the next document fine. Demotion
 * is a capability failure's job, not this one's.
 */
export class UnsupportedItemError extends TerminalQueueError {
  override readonly name = "UnsupportedItemError";
  readonly engine: string;
  readonly reason: UnsupportedItemReason;
  readonly detail: string;

  constructor(init: UnsupportedItemInit) {
    super(`${init.engine} cannot handle this item: ${init.reason} — ${init.detail}`, {
      cause: init.cause,
    });
    this.engine = init.engine;
    this.reason = init.reason;
    this.detail = init.detail;
  }
}
