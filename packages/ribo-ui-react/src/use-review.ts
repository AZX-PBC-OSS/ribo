import type { z } from "zod";
import type {
  FieldDecision,
  FieldDecisions,
  FieldPath,
  Outbox,
  OutboxItem,
  PersistedReviewOutcome,
  ReviewFields,
  ReviewIssue,
  ReviewOutcome,
  ReviewRequest,
  Transcript,
} from "@azx/ribo-core";
import { buildReviewRequest, resolveReview, ReviewValidationError } from "@azx/ribo-core";
import { useCallback, useMemo, useState } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";

export interface UseReviewOptions {
  /**
   * The adapter's **patch** schema (`ToolAdapter.schema`) — what decides which
   * leaves exist and what a legal value for each one is.
   *
   * The schema rather than the adapter, on least privilege: this hook needs to walk
   * a `ZodObject`, and a `ToolAdapter` would also hand it `write()` and
   * `instructions`, which a review card has no business with. It also keeps the
   * `ToolAdapter` type out of this package entirely, which is what makes AGENTS.md
   * §4's "a review UI needs no adapter import" true rather than nearly true.
   *
   * **Hold it still.** It is a `useMemo` dependency, so an inline `z.object({ … })`
   * rebuilds every field on every render and a text input loses focus on every
   * keystroke. An adapter's schema is a module-level constant, which is the
   * intended shape of this argument.
   */
  readonly valuesSchema: z.ZodObject;
  /** Bypasses the provider. What the tests inject through. */
  readonly outbox?: Outbox;
}

export interface UseReviewResult {
  /** The item has both a transcript and an extraction, so review can proceed. */
  readonly ready: boolean;
  /** Every leaf of `valuesSchema`, by dotted path, in schema-declaration order. */
  readonly fields: ReviewFields | undefined;
  readonly transcript: Transcript | undefined;
  /** `undefined` if the item is not ready, or the path is not a leaf of this review. */
  readonly decisionOf: (path: FieldPath) => FieldDecision | undefined;
  readonly accept: (path: FieldPath) => void;
  /** @throws if `value` is `undefined` — see the guard's note. */
  readonly edit: (path: FieldPath, value: unknown) => void;
  readonly reject: (path: FieldPath) => void;
  /** Leaves the human has not acted on. Every leaf starts here. */
  readonly untouched: readonly FieldPath[];
  /**
   * One message per leaf the last {@link UseReviewResult.submit} was refused over,
   * for showing beside that leaf's editor.
   *
   * A record rather than core's `ReviewIssue[]` so a field row is an O(1) lookup
   * instead of a scan every row would rewrite for itself; one string rather than a
   * list because core already joins a leaf's issues into one sentence and an editor
   * has one error slot. The ordered original stays on
   * {@link UseReviewResult.error}`.issues`.
   */
  readonly errors: Readonly<Record<FieldPath, string>>;
  readonly submit: () => Promise<ReviewOutcome>;
  readonly discard: (reason?: string) => Promise<ReviewOutcome>;
  readonly submitting: boolean;
  readonly error: Error | undefined;
}

/** What this hook remembers, all of it scoped to one item. */
interface ReviewState {
  readonly forItem: string | undefined;
  readonly decisions: Readonly<Record<FieldPath, FieldDecision>>;
  readonly errors: Readonly<Record<FieldPath, string>>;
}

/** What a card shows for an item it holds nothing about — including a different one. */
const NOTHING: ReviewState = { forItem: undefined, decisions: {}, errors: {} };

/**
 * `ReviewIssue[]` → one message per leaf.
 *
 * First message wins on a repeated path. Core reports at most one issue per leaf
 * today — `resolveReview` joins a leaf's zod issues into a single sentence itself —
 * so this only decides a case that does not arise, and deciding it keeps the map
 * from depending on iteration order if it ever does.
 */
const indexIssues = (issues: readonly ReviewIssue[]): Record<FieldPath, string> => {
  const byPath: Record<FieldPath, string> = {};
  for (const issue of issues) byPath[issue.path] ??= issue.message;
  return byPath;
};

/** The same errors without `path`. */
const withoutPath = (
  errors: Readonly<Record<FieldPath, string>>,
  path: FieldPath,
): Record<FieldPath, string> =>
  Object.fromEntries(Object.entries(errors).filter(([key]) => key !== path));

/**
 * `ReviewOutcome` → {@link PersistedReviewOutcome}.
 *
 * Not a cast: `editedFields` / `rejectedFields` are `readonly FieldPath[]` on the
 * typed outcome (§ this file's leaf paths are read-only once resolved) but
 * `PersistedReviewOutcome`'s array fields are the plain mutable `string[]`
 * `reviewOutcomeSchema` infers, so the two are not structurally assignable — `tsc`
 * refuses `readonly string[]` where `string[]` is declared, correctly, because a
 * callee holding a mutable array could mutate what the caller still treats as
 * read-only. Spreading into a fresh array is the honest fix: it costs nothing at
 * 34 leaves and keeps this boundary a real value conversion rather than a type
 * assertion papering over it.
 */
const toPersisted = (outcome: ReviewOutcome): PersistedReviewOutcome =>
  outcome.status === "edited"
    ? {
        ...outcome,
        editedFields: [...outcome.editedFields],
        rejectedFields: [...outcome.rejectedFields],
      }
    : outcome;

/**
 * Field-by-field review of one parked item.
 *
 * ```tsx
 * const { fields, decisionOf, edit, reject, errors, submit } = useReview(item, {
 *   valuesSchema: snuggValuesSchema,
 * });
 * ```
 *
 * ## Leaves, not fields
 *
 * Everything here is addressed by dotted leaf path — `"healthSafety.ambientCo"`,
 * not `"healthSafety"` — because an auditor has to be able to accept the ambient-CO
 * result while correcting the asbestos one. `buildReviewRequest` walks
 * `valuesSchema` to decide which leaves exist, so a leaf the model omitted is still
 * presented (with the sentinel envelope) rather than silently missing from the card.
 *
 * ## Decisions start complete, and core is what enforces that
 *
 * Every leaf starts `{ status: "accepted" }`, and {@link UseReviewResult.untouched}
 * reports what nobody acted on, so a host can require every `isGrounded: false` leaf
 * to be visited before enabling submit. That is a UI affordance for the human.
 *
 * The *guarantee* — "a leaf with no decision is indistinguishable from a leaf the
 * reviewer never saw, and 'I did not look at it' must not silently mean 'accepted'"
 * — is no longer carried by the type: `FieldDecisions` is a string-keyed record and
 * accepts `{}`. `resolveReview` compares the submitted path set against the
 * request's and refuses a mismatch either way, and **that** is the authority.
 * {@link UseReviewResult.submit} below builds a decision for every leaf precisely so
 * that check passes; if it ever fires from here, this hook is wrong, not its caller.
 *
 * ## Decision state is keyed by item id, read through a synchronous guard
 *
 * A queue UI reuses one mounted card for the next parked item, and leaf paths
 * repeat across recordings — so decisions carried over would submit silently,
 * attributing one auditor's correction to another recording. An effect-based
 * reset still leaves one render where the stale decisions are live and
 * submittable, which is one render too many when submit is a click. So `state`
 * is read through a guard (`state.forItem === item?.id`) rather than reset in an
 * effect: the very first render after `item` changes sees `NOTHING`.
 */
export function useReview(
  item: OutboxItem | undefined,
  options: UseReviewOptions,
): UseReviewResult {
  const { valuesSchema } = options;
  const outbox = useRiboInstance("outbox", options.outbox);

  const [state, setState] = useState<ReviewState>({
    forItem: item?.id,
    decisions: {},
    errors: {},
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  // Synchronously empty whenever the state belongs to a different item. No effect,
  // no stale window.
  //
  // This hook has no `useEffect` anywhere in it — every derived value here is a
  // plain read computed during render, including this guard. That is also why
  // it does not need a dedicated StrictMode test the way `use-subscribed.ts`
  // does: StrictMode's double mount/cleanup/remount exists to surface a missing
  // *effect* cleanup, and there is no effect here for it to double-invoke.
  const { decisions, errors } = state.forItem === item?.id ? state : NOTHING;

  const setDecision = useCallback(
    (path: FieldPath, decision: FieldDecision) => {
      const id = item?.id;
      setState((prior) => {
        const base = prior.forItem === id ? prior : NOTHING;
        return {
          forItem: id,
          decisions: { ...base.decisions, [path]: decision },
          // Deciding a leaf answers whatever the last submit said about it —
          // including "reject it instead", which is the escape core's own message
          // names for an extracted value that cannot be accepted as it stands.
          errors: withoutPath(base.errors, path),
        };
      });
    },
    [item?.id],
  );

  const request = useMemo<ReviewRequest | undefined>(() => {
    if (item?.extracted === undefined || item.transcript === undefined) return undefined;
    // No cast on the way in: `extracted` is persisted as `Record<string, unknown>`
    // and that is exactly what `buildReviewRequest` takes.
    return buildReviewRequest(item.extracted, item.transcript, valuesSchema);
  }, [item?.extracted, item?.transcript, valuesSchema]);

  const paths = useMemo<readonly FieldPath[]>(
    () => (request === undefined ? [] : Object.keys(request.fields)),
    [request],
  );

  const decisionOf = useCallback(
    (path: FieldPath): FieldDecision | undefined =>
      request === undefined || !Object.hasOwn(request.fields, path)
        ? undefined
        : (decisions[path] ?? { status: "accepted" }),
    [decisions, request],
  );

  const accept = useCallback(
    (path: FieldPath) => setDecision(path, { status: "accepted" }),
    [setDecision],
  );

  const edit = useCallback(
    (path: FieldPath, value: unknown) => {
      // `undefined` PASSES every patch leaf's schema — each is `.optional()` — and
      // then vanishes on serialisation, leaving the leaf ABSENT, which the patch
      // model defines as "do not touch this field", while `editedFields` still
      // names it as touched. `resolveReview` refuses it; this is the same refusal
      // moved to the call site, because a React editor whose state is `undefined`
      // submits exactly this and the useful place to report a host bug in an
      // `onChange` is the keystroke that caused it.
      //
      // Deliberately NOT normalised to `null`: that writes an empty value the human
      // never asked for, and fails anyway on a leaf that is `.optional()` but not
      // `.nullable()`.
      if (value === undefined) {
        throw new Error(
          `ribo: cannot edit "${path}" to undefined — it would be dropped on save and read back as "leave this field alone". Use edit("${path}", null) to record that there is nothing to put here, or reject("${path}") to leave the field untouched.`,
        );
      }
      setDecision(path, { status: "edited", value });
    },
    [setDecision],
  );

  const reject = useCallback(
    (path: FieldPath) => setDecision(path, { status: "rejected" }),
    [setDecision],
  );

  const untouched = useMemo(
    () => paths.filter((path) => decisions[path] === undefined),
    [decisions, paths],
  );

  const settle = useCallback(
    async (outcome: ReviewOutcome): Promise<ReviewOutcome> => {
      if (item === undefined) throw new Error("ribo: cannot submit a review with no item.");
      setSubmitting(true);
      setError(undefined);
      try {
        // `toPersisted` is a value conversion, not a cast — see its own note. What
        // gets sent is still structurally identical to `outcome`, and
        // `submitReview` re-parses it regardless.
        await outbox.submitReview(item.id, toPersisted(outcome));
        return outcome;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        setError(failure);
        throw failure;
      } finally {
        setSubmitting(false);
      }
    },
    [item, outbox],
  );

  const submit = useCallback(async (): Promise<ReviewOutcome> => {
    if (request === undefined) throw new Error("ribo: this item is not ready for review.");
    const id = item?.id;
    // A decision for every leaf, defaulting to accepted. This is what makes
    // `resolveReview`'s completeness check pass; the check, not this line, is the
    // guarantee.
    const complete: FieldDecisions = Object.fromEntries(
      paths.map((path) => [path, decisions[path] ?? { status: "accepted" }]),
    );

    let outcome: ReviewOutcome;
    try {
      outcome = resolveReview(request, { status: "submitted", decisions: complete });
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      // REPLACED, not merged: each submit is a complete verdict over every leaf, so
      // a message carried over from an earlier attempt would flag a leaf that is
      // now fine.
      setState((prior) => ({
        forItem: id,
        decisions: prior.forItem === id ? prior.decisions : {},
        errors: failure instanceof ReviewValidationError ? indexIssues(failure.issues) : {},
      }));
      setError(failure);
      // Still thrown. A caller that ignores a refused submission must not carry on
      // as though the review went in; `errors` is for showing it, not for replacing
      // the failure.
      throw failure;
    }

    // Deliberate, known-redundant defence-in-depth: reaching this line means
    // `resolveReview` just accepted `complete`, and the only way any leaf's error
    // could have gone stale is for that leaf's decision to change — which always
    // routes through `setDecision`'s own `withoutPath` clearing. So `errors` is
    // already `{}` by construction every time a submit gets this far, and no test
    // can distinguish removing this line from keeping it. It stays anyway, so a
    // future change to how a leaf's error gets cleared can't silently leave a
    // stale one behind here.
    setState((prior) => (prior.forItem === id ? { ...prior, errors: {} } : prior));
    return await settle(outcome);
  }, [decisions, item?.id, paths, request, settle]);

  const discard = useCallback(
    async (reason?: string): Promise<ReviewOutcome> =>
      await settle(
        reason === undefined ? { status: "discarded" } : { status: "discarded", reason },
      ),
    [settle],
  );

  return {
    ready: request !== undefined,
    fields: request?.fields,
    transcript: request?.transcript,
    decisionOf,
    accept,
    edit,
    reject,
    untouched,
    errors,
    submit,
    discard,
    submitting,
    error,
  };
}
