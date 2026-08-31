import type { ToolAdapter } from "./adapter.js";
import { TerminalQueueError } from "./queue/backoff.js";
import type { SessionWriteStep, SessionWriteInput } from "./queue/relay.js";
import { describeLocated, zodIssues } from "./zod-issues.js";

/**
 * @file The composition that hands what review settled on to a {@link ToolAdapter} —
 * and the trust boundary the write path was missing.
 *
 * ## Why this exists at all
 *
 * `RelayOptions.sessionWrite` is a bare host-supplied function. The relay is never handed an
 * adapter, so "the adapter's schema is the trust boundary before a write" described a
 * boundary that **was not installed anywhere**: every reasoning about it — a rejected
 * leaf being absent, an accepted `null` being present, the reviewed values being a
 * legal `V` at all — rested on a `parse` no code in this package ran. R2 Phase A's
 * review found that; {@link toWriteStep} is where the boundary now lives, and it is the
 * one supported way to wire an adapter into the queue:
 *
 * ```ts
 * createRelay({ ..., sessionWrite: toWriteStep(snuggProAdapter) });
 * ```
 *
 * ## What the patch parse actually guards against
 *
 * Not `resolveReview`. That function validates every accepted and edited value against
 * its leaf's own schema before it returns, so an outcome it produced is a valid `V` by
 * construction. What the parse guards is every OTHER route a patch can take to
 * `SessionWriteInput.reviewed`: a host calling `Outbox.patchSession(id, { reviewOutcome })`
 * directly, an outcome written by an older build and read back after a schema change,
 * a future UI that persists its own outcome. All of those are `unknown` by the time
 * they reach here, and the adapter's schema is the last thing between them and a
 * customer's audit.
 *
 * ## ctx comes from the relay, not the recording
 *
 * The relay reads `ctx` from one of the session's transcribed recordings and passes
 * it in `SessionWriteInput.ctx`. All recordings in a session share the same `ctx`
 * (they are for the same job), so which recording's `ctx` is used does not matter.
 * The step does not close over a `ctx` at construction — same reasoning as before
 * the split, just moved one layer out.
 *
 * ## Both parses are terminal
 *
 * A reviewed patch that fails `adapter.schema`, or a `ctx` that fails
 * `adapter.ctxSchema`, will fail identically on every retry: the inputs are already
 * persisted and nothing about a second attempt changes them. So both throw a
 * {@link TerminalQueueError}, which `isTransientFailure` classifies as non-retryable and
 * the relay records as `dead` on the first failure.
 */

/**
 * Collapse a {@link ToolAdapter} onto the relay's injected `SessionWriteStep`.
 *
 * Per session it:
 *
 *   1. parses `input.ctx` with `adapter.ctxSchema`, so the destination
 *      travels with the recording rather than with the step;
 *   2. parses `input.reviewed` with `adapter.schema`, so what reaches `write` is a
 *      checked `V` and not whatever a UI happened to persist;
 *   3. calls `adapter.write(fields, ctx, { idempotencyKey: input.idempotencyKey })`.
 *
 * **`write`'s own rejection is passed through untouched**, and the `await` is deliberately
 * not wrapped. A network failure from a real adapter is the single most common thing this
 * step will ever see, and it is exactly what must be retried.
 */
export function toWriteStep<V extends Record<string, unknown>, C>(
  adapter: ToolAdapter<V, C>,
): SessionWriteStep {
  return async ({ session, reviewed, idempotencyKey, ctx }: SessionWriteInput): Promise<void> => {
    const parsedCtx = adapter.ctxSchema.safeParse(ctx);
    if (!parsedCtx.success) {
      throw new TerminalQueueError(
        `session ${session.id}: its recording's ctx is not a valid write context for the ` +
          `"${adapter.name}" adapter — ${describeLocated(zodIssues(parsedCtx.error))}. The context is captured ` +
          "with the recording and cannot be repaired by retrying; check what the host put in " +
          "`Recording.ctx` at enqueue.",
      );
    }

    const fields = adapter.schema.safeParse(reviewed);
    if (!fields.success) {
      throw new TerminalQueueError(
        `session ${session.id}: the reviewed values are not a valid patch for the ` +
          `"${adapter.name}" adapter — ${describeLocated(zodIssues(fields.error))}. Nothing was written. ` +
          "The review outcome is already persisted, so a retry would fail identically; " +
          "to try again, re-park with Outbox.reopenSessionForReview(id) and review it afresh.",
      );
    }

    await adapter.write(fields.data, parsedCtx.data, { idempotencyKey });
  };
}
