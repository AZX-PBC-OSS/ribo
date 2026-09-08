import type { ToolAdapter } from "./adapter.js";
import { TerminalQueueError } from "./queue/backoff.js";
import type { SessionWriteResult, SessionWriteStep, SessionWriteInput } from "./queue/relay.js";
import { describeLocated, zodIssues } from "./zod-issues.js";

/**
 * A sibling composition of {@link toWriteStep} that writes each collection
 * instance separately, so a vendor can honour `Idempotency-Key` per instance.
 *
 * `ToolAdapter.write` is unchanged: it still receives a parsed `V`, a parsed
 * context, and a `WriteMetadata` idempotency key. Only the *value* of that key
 * differs per instance, derived deterministically from the item key, the group
 * and the instance's position. Determinism is the whole point: the same retry
 * re-derives the same key for the same instance, so a vendor that honours
 * `Idempotency-Key` recognises a retry rather than creating a duplicate record.
 *
 * **What was given up:** a write interrupted mid-collection now re-attempts
 * instances it already sent, resting on the per-instance idempotency key alone.
 * The positional `writtenInstances` marker that used to skip them was deleted
 * because it carried a live data-loss bug (a reopened session with a removed
 * instance silently skipped the survivor), and every repair considered
 * substituted for the vendor identifier `write` discards. That durable channel
 * is now the `SessionWriteResult.receipts` return — keyed by the real instance
 * key the reviewed outcome declares, not by array position, so the survivor of a
 * removal keeps its own receipt rather than inheriting the deleted one's.
 *
 * Singleton groups are written together with the session's original idempotency
 * key, which is the correct granularity for one record per patch. A group with
 * an empty array (`[]`) writes nothing — neither creating nor deleting records.
 *
 * @param options.adapter - the tool adapter whose schema and write back this step
 *   delegates to.
 * @param options.collectionGroups - top-level field names that are per-instance
 *   arrays in the adapter's schema. Every other top-level field is treated as a
 *   singleton and written once.
 */
export interface ToInstanceWriteStepOptions<V extends Record<string, unknown>, C> {
  readonly adapter: ToolAdapter<V, C>;
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
 * Build a per-instance write step from an adapter and the list of collection
 * groups the adapter models as per-instance arrays.
 */
export function toInstanceWriteStep<V extends Record<string, unknown>, C>(
  options: ToInstanceWriteStepOptions<V, C>,
): SessionWriteStep {
  const { adapter, collectionGroups } = options;
  return async ({
    session,
    reviewed,
    idempotencyKey,
    ctx,
  }: SessionWriteInput): Promise<SessionWriteResult> => {
    const parsedCtx = adapter.ctxSchema.safeParse(ctx);
    if (!parsedCtx.success) {
      throw new TerminalQueueError(
        `session ${session.id}: its ctx is not a valid write context for the ` +
          `"${adapter.name}" adapter — ${describeLocated(zodIssues(parsedCtx.error))}. The context is set ` +
          "at session open and cannot be repaired by retrying; check what the host passed to " +
          "`Outbox.openSession`.",
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

    // Checked before any write runs, not just before the instance loop: a
    // malformed or missing review outcome must fail before the singleton write
    // below has a chance to reach a real vendor, the same "both parses are
    // terminal, before any write" ordering this file's ctx/fields checks above
    // already follow.
    const outcome = session.reviewOutcome;
    if (outcome === undefined || outcome.status === "discarded") {
      throw new TerminalQueueError(
        `session ${session.id} reached the instance write step with no reviewable outcome.`,
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

    const receipts: { singleton?: string; instances: Record<string, Record<string, string>> } = {
      instances: {},
    };

    if (Object.keys(singletonPatch).length > 0) {
      const { uuid } = await adapter.write(
        adapter.schema.parse(singletonPatch) as V,
        parsedCtx.data,
        {
          idempotencyKey,
        },
      );
      receipts.singleton = uuid;
    }

    for (const { group, instances } of collections) {
      if (instances.length === 0) continue;
      for (let index = 0; index < instances.length; index += 1) {
        const instancePatch = { [group]: [instances[index]] };
        const instanceIdempotencyKey = deriveInstanceIdempotencyKey(idempotencyKey, group, index);
        const instanceKey = outcome.instanceKeys?.[group]?.[index];
        if (instanceKey === undefined) {
          throw new TerminalQueueError(
            `session ${session.id}: no instance key found for group "${group}" at index ${index} — ` +
              "receipts cannot be safely recorded without a real key.",
          );
        }
        const { uuid } = await adapter.write(
          adapter.schema.parse(instancePatch) as V,
          parsedCtx.data,
          {
            idempotencyKey: instanceIdempotencyKey,
          },
        );
        receipts.instances[group] ??= {};
        receipts.instances[group][instanceKey] = uuid;
      }
    }

    return {
      receipts: {
        ...(receipts.singleton !== undefined ? { singleton: receipts.singleton } : {}),
        ...(Object.keys(receipts.instances).length > 0 ? { instances: receipts.instances } : {}),
      },
    };
  };
}
