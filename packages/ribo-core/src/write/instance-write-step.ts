import type { ToolAdapter } from "./adapter.js";
import { TerminalError } from "../storage/backoff.js";
import type { SessionWriteResult, SessionWriteStep, SessionWriteInput } from "../storage/relay.js";
import { describeLocated, zodIssues } from "../review/zod-issues.js";

/**
 * A sibling composition of {@link toWriteStep} that writes each collection
 * instance separately.
 *
 * `ToolAdapter.write` is unchanged: it still receives a parsed `V`, a parsed
 * context, and a `WriteMetadata` idempotency key. Only the *value* of that key
 * differs per instance, derived deterministically from the item key, the group
 * and the instance's position. The key is still sent as `Idempotency-Key`, but
 * **nothing rests on it**: measured 2026-09-21 against Snugg Pro's staging API,
 * replaying a byte-identical create with the same key returned a new uuid, and
 * their spec declares no idempotency support. It stays because it is harmless
 * and free if a vendor ever honours it.
 *
 * Duplicate protection is the **receipt**. Each successful instance write is
 * checkpointed through `SessionWriteInput.recordReceipt` as it is earned — so
 * a throw later in the loop cannot discard it — and the next attempt UPDATEs
 * the receipted record instead of creating again. The accumulate-and-return of
 * `SessionWriteResult.receipts` stays as the second channel; the return, not
 * the checkpoint, is the contract a host step must keep.
 *
 * **What was given up:** nothing that the receipt does not restore. The
 * positional `writtenInstances` marker that used to skip already-sent
 * instances was deleted because it carried a live data-loss bug (a reopened
 * session with a removed instance silently skipped the survivor). Receipts
 * are keyed by the real instance key the reviewed outcome declares, not by
 * array position, so the survivor of a removal keeps its own receipt rather
 * than inheriting the deleted one's.
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
 * The item key is the storage item's `idempotencyKey`. The group is the top-level
 * collection name (e.g. `"hvac"`). The index is the instance's position in the
 * emitted array, which is first-mention order. The same inputs always produce
 * the same output, so a retry re-derives the same key for the same instance.
 *
 * Stability is not duplicate protection: no vendor here honours
 * `Idempotency-Key` (measured 2026-09-21 against Snugg Pro's staging API). The
 * receipt — a retry UPDATEs the record a previous attempt's receipt names — is the
 * mechanism; the key is still sent because it is harmless and free.
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
    recordReceipt,
  }: SessionWriteInput): Promise<SessionWriteResult> => {
    const parsedCtx = adapter.ctxSchema.safeParse(ctx);
    if (!parsedCtx.success) {
      throw new TerminalError(
        `session ${session.id}: its ctx is not a valid write context for the ` +
          `"${adapter.name}" adapter — ${describeLocated(zodIssues(parsedCtx.error))}. The context is set ` +
          "at session open and cannot be repaired by retrying; check what the host passed to " +
          "`storage.sessions.open`.",
      );
    }

    const fields = adapter.schema.safeParse(reviewed);
    if (!fields.success) {
      throw new TerminalError(
        `session ${session.id}: the reviewed values are not a valid patch for the ` +
          `"${adapter.name}" adapter — ${describeLocated(zodIssues(fields.error))}. Nothing was written. ` +
          "The review outcome is already persisted, so a retry would fail identically; " +
          "to try again, re-park with Storage.sessions.reopenForReview(id) and review it afresh.",
      );
    }

    // Checked before any write runs, not just before the instance loop: a
    // malformed or missing review outcome must fail before the singleton write
    // below has a chance to reach a real vendor, the same "both parses are
    // terminal, before any write" ordering this file's ctx/fields checks above
    // already follow.
    const outcome = session.reviewOutcome;
    if (outcome === undefined || outcome.status === "discarded") {
      throw new TerminalError(
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
      const { receipt } = await adapter.write(
        adapter.schema.parse(singletonPatch),
        parsedCtx.data,
        {
          idempotencyKey,
        },
      );
      receipts.singleton = receipt;
    }

    for (const { group, instances } of collections) {
      if (instances.length === 0) continue;
      for (let index = 0; index < instances.length; index += 1) {
        const instancePatch = { [group]: [instances[index]] };
        const instanceIdempotencyKey = deriveInstanceIdempotencyKey(idempotencyKey, group, index);
        const instanceKey = outcome.instanceKeys?.[group]?.[index];
        if (instanceKey === undefined) {
          throw new TerminalError(
            `session ${session.id}: no instance key found for group "${group}" at index ${index} — ` +
              "receipts cannot be safely recorded without a real key.",
          );
        }
        // This index is the same positional index `outcome.instanceKeys` and
        // `outcome.linkTargets` are aligned to: `buildInstancePositions`
        // establishes first-mention order, review builds both maps against it,
        // and this loop walks the same array in the same order. If those three
        // ever disagree, a human's link decision attaches to the wrong physical
        // record — which is why the alignment is pinned in the tests, not
        // enforced here.
        // A human's link decision wins. Without one — including an explicit
        // `null`, whose create has already happened if a receipt exists — a
        // receipt from an earlier attempt means the record exists: UPDATE it
        // rather than create a duplicate.
        const decision = outcome.linkTargets?.[group]?.[index];
        const linkTarget =
          typeof decision === "string"
            ? decision
            : session.receipts?.instances?.[group]?.[instanceKey];
        const { receipt } = await adapter.write(
          adapter.schema.parse(instancePatch),
          parsedCtx.data,
          // A missing or `null` target means CREATE — the documented default,
          // and the normal case: unlike `instanceKey` above, whose absence
          // means receipts cannot be recorded safely, an unlinked instance is
          // not an error, and throwing here would break every one of them. The
          // member is omitted rather than passed as `undefined`, because absent
          // is not a value.
          {
            idempotencyKey: instanceIdempotencyKey,
            ...(typeof linkTarget === "string" ? { linkTarget } : {}),
          },
        );
        receipts.instances[group] ??= {};
        receipts.instances[group][instanceKey] = receipt;
        // Checkpoint the receipt as it is earned, not just at the end: a throw
        // on a later instance must not discard the ones that already landed.
        await recordReceipt(group, instanceKey, receipt);
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
