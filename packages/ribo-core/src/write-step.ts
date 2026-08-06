import type { ZodError } from "zod";

import type { ToolAdapter } from "./adapter.js";
import { TerminalQueueError } from "./queue/backoff.js";
import type { WriteStep, WriteStepInput } from "./queue/relay.js";

/**
 * @file The composition that hands what review settled on to a {@link ToolAdapter} —
 * and the trust boundary the write path was missing.
 *
 * ## Why this exists at all
 *
 * `RelayOptions.write` is a bare host-supplied function. The relay is never handed an
 * adapter, so "the adapter's schema is the trust boundary before a write" described a
 * boundary that **was not installed anywhere**: every reasoning about it — a rejected
 * leaf being absent, an accepted `null` being present, the reviewed values being a
 * legal `V` at all — rested on a `parse` no code in this package ran. R2 Phase A's
 * review found that; {@link toWriteStep} is where the boundary now lives, and it is the
 * one supported way to wire an adapter into the queue:
 *
 * ```ts
 * createRelay({ ..., write: toWriteStep(snuggProAdapter) });
 * ```
 *
 * ## It takes no `ctx`, and that is the point
 *
 * The context is resolved **per item**, from `input.item.recording.ctx`, never captured
 * when the step is built. `Recording.ctx` exists precisely so a host association
 * "survives the round trip through the queue" (`recording.ts`), and the queue is not a
 * single job: two recordings from two different assessments sit in the same outbox and
 * drain through the same step. A composition that closed over one `ctx` at construction
 * would send both to whichever destination was captured first — silently, with no
 * failure anywhere, in the direction that writes one house's findings onto another's
 * audit. `write-step.test.ts` pins two items with different contexts reaching `write`
 * with different destinations, and that test is this file's reason for its shape.
 *
 * ## Both parses are terminal
 *
 * A reviewed patch that fails `adapter.schema`, or a persisted `ctx` that fails
 * `adapter.ctxSchema`, will fail identically on every retry: the inputs are already
 * persisted and nothing about a second attempt changes them. So both throw a
 * {@link TerminalQueueError}, which `isTransientFailure` classifies as non-retryable and
 * the relay records as `dead` on the first failure. Spending eight backoff windows on a
 * deterministic failure only delays telling a human, and a human is the only thing that
 * can fix either one.
 */

/** One zod failure, rendered as `path: message` — or just the message at the root. */
const describeIssues = (error: ZodError): string =>
  error.issues
    .map((issue) => {
      // `path` is `PropertyKey[]`: mapped through `String` rather than joined
      // directly, because `Array.prototype.join` throws on a symbol key.
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");

/**
 * Collapse a {@link ToolAdapter} onto the relay's injected `WriteStep`.
 *
 * The sibling of `toExtractStep`, and the same one-line shape — but where that one only
 * renames a result, this one is a boundary. Per item it:
 *
 *   1. parses `input.item.recording.ctx` with `adapter.ctxSchema`, so the destination
 *      travels with the recording rather than with the step (see the file header);
 *   2. parses `input.reviewed` with `adapter.schema`, so what reaches `write` is a
 *      checked `V` and not whatever a UI happened to persist;
 *   3. calls `adapter.write(fields, ctx, { idempotencyKey: input.idempotencyKey })`.
 *
 * Nothing is returned to the relay: `ToolAdapter.write` resolves `void`, so there is no
 * `writeResult` to persist. A failed parse throws before `write` is called at all —
 * nothing partially-validated ever reaches a customer's tool.
 *
 * The ctx is parsed **first**, deliberately. Both failures are terminal so the order
 * cannot change an item's fate, but an item whose destination is unusable has a problem
 * with the recording, not with the review, and reporting the field-level errors of a
 * patch nobody could have written anywhere is the less useful of the two messages.
 */
export function toWriteStep<V, C>(adapter: ToolAdapter<V, C>): WriteStep {
  return async ({ item, reviewed, idempotencyKey }: WriteStepInput): Promise<void> => {
    const ctx = adapter.ctxSchema.safeParse(item.recording.ctx);
    if (!ctx.success) {
      throw new TerminalQueueError(
        `outbox item ${item.id}: its recording's ctx is not a valid write context for the ` +
          `"${adapter.name}" adapter — ${describeIssues(ctx.error)}. The context is captured ` +
          "with the recording and cannot be repaired by retrying; check what the host put in " +
          "`Recording.ctx` at enqueue.",
      );
    }

    const fields = adapter.schema.safeParse(reviewed);
    if (!fields.success) {
      throw new TerminalQueueError(
        `outbox item ${item.id}: the reviewed values are not a valid patch for the ` +
          `"${adapter.name}" adapter — ${describeIssues(fields.error)}. Nothing was written. ` +
          "The review outcome is already persisted, so a retry would fail identically; " +
          'to try again, re-park the item with Outbox.patch(id, { status: "awaiting-review" }) ' +
          "and review it afresh.",
      );
    }

    await adapter.write(fields.data, ctx.data, { idempotencyKey });
  };
}
