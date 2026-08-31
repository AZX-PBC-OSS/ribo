import type { ToolAdapter } from "./adapter.js";
import { TerminalQueueError } from "./queue/backoff.js";
import type { Outbox } from "./queue/outbox.js";
import type { SessionWriteStep, SessionWriteInput } from "./queue/relay.js";
import { describeLocated, zodIssues } from "./zod-issues.js";

/**
 * A sibling composition of {@link toWriteStep} that writes each collection
 * instance separately, so a retry can resume mid-patch rather than replaying
 * instances that already succeeded.
 *
 * `ToolAdapter.write` is unchanged: it still receives a parsed `V`, a parsed
 * context, and a `WriteMetadata` idempotency key. Only the *value* of that key
 * differs per instance, derived deterministically from the item key, the group
 * and the instance's position. Determinism is the whole point: the same retry
 * re-derives the same key for the same instance, so a vendor that honours
 * `Idempotency-Key` recognises a retry rather than creating a duplicate record.
 *
 * The per-instance write step also persists per-instance progress on the session
 * (`SessionDocument.writtenInstances`) before moving on. That narrows, but does
 * not close, the ambiguous-success window: if the vendor ignores the header, a
 * crash between the API creating a record and our persisting this marker can
 * still duplicate on retry. Server-side idempotency is required to eliminate it.
 *
 * Singleton groups are written together with the session's original idempotency
 * key, which is the correct granularity for one record per patch. A group with
 * an empty array (`[]`) writes nothing — neither creating nor deleting records.
 *
 * @param options.adapter - the tool adapter whose schema and write back this step
 *   delegates to.
 * @param options.outbox - the durable outbox to persist `writtenInstances` into.
 * @param options.collectionGroups - top-level field names that are per-instance
 *   arrays in the adapter's schema. Every other top-level field is treated as a
 *   singleton and written once.
 */
export interface ToInstanceWriteStepOptions<V extends Record<string, unknown>, C> {
  readonly adapter: ToolAdapter<V, C>;
  readonly outbox: Outbox;
  readonly collectionGroups: readonly string[];
}

/**
 * Derive a per-instance idempotency key that is stable across retries of the
 * same instance and distinct between instances of the same item.
 *
 * The item key is the outbox item's `idempotencyKey`. The group is the top-level
 * collection name (e.g. `"hvac"`). The index is the instance's position in the
 * emitted array, which is first-mention order. The same inputs always produce
 * the same output, so a retry re-derives the same key for the same instance.
 */
export function deriveInstanceIdempotencyKey(
  itemKey: string,
  group: string,
  index: number,
): string {
  return `${itemKey}:instance:${group}:${index}`;
}

/**
 * Build a per-instance write step from an adapter, an outbox and the list of
 * collection groups the adapter models as per-instance arrays.
 */
export function toInstanceWriteStep<V extends Record<string, unknown>, C>(
  options: ToInstanceWriteStepOptions<V, C>,
): SessionWriteStep {
  const { adapter, outbox, collectionGroups } = options;
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

    const singletonPatch: Record<string, unknown> = {};
    const collections: Array<{ group: string; instances: unknown[] }> = [];

    for (const [key, value] of Object.entries(fields.data)) {
      if (collectionGroups.includes(key) && Array.isArray(value)) {
        collections.push({ group: key, instances: value });
      } else {
        singletonPatch[key] = value;
      }
    }

    if (Object.keys(singletonPatch).length > 0) {
      await adapter.write(adapter.schema.parse(singletonPatch) as V, parsedCtx.data, {
        idempotencyKey,
      });
    }

    let writtenInstances: Record<string, boolean[]> = { ...(session.writtenInstances ?? {}) };
    for (const { group, instances } of collections) {
      if (instances.length === 0) continue;
      for (let index = 0; index < instances.length; index += 1) {
        if (writtenInstances[group]?.[index]) continue;

        const instancePatch = { [group]: [instances[index]] };
        const instanceKey = deriveInstanceIdempotencyKey(idempotencyKey, group, index);
        await adapter.write(adapter.schema.parse(instancePatch) as V, parsedCtx.data, {
          idempotencyKey: instanceKey,
        });

        writtenInstances = markInstanceWritten(writtenInstances, group, index);
        await outbox.patchSession(session.id, { writtenInstances });
      }
    }
  };
}

function markInstanceWritten(
  written: Record<string, boolean[]>,
  group: string,
  index: number,
): Record<string, boolean[]> {
  const next = { ...written };
  const groupProgress = [...(next[group] ?? [])];
  while (groupProgress.length < index) groupProgress.push(false);
  groupProgress[index] = true;
  next[group] = groupProgress;
  return next;
}
