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
import { useCallback, useMemo, useRef, useState } from "react";

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
  /**
   * Leaf paths the host tool refuses to CREATE the record without — passed straight
   * through to `buildReviewRequest`'s `requiredOnCreate`, so each named leaf's own
   * `ReviewField.required` is `true` and a card can mark it and refuse a submit
   * that leaves it empty.
   *
   * Hosts pass `adapter.requiredOnCreate` (`ToolAdapter.requiredOnCreate`) here — the
   * same reason `valuesSchema` above takes the schema and not the adapter: this hook
   * needs the one list, not the whole `ToolAdapter`. Omitted paths are simply never
   * required, which is what "the adapter declares nothing" already means on the core
   * side.
   *
   * **Hold it still, like `valuesSchema`.** It is also a `useMemo` dependency; an
   * inline array literal is a new reference every render and rebuilds `fields` on
   * every render along with it.
   */
  readonly requiredOnCreate?: readonly FieldPath[];
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

/**
 * What this hook remembers, all of it scoped to one item.
 *
 * `submitting` and `error` live here too, alongside `decisions`/`errors`, and not
 * in their own `useState`s — that split is what let them leak across items in an
 * earlier version: they were read straight off their own hooks with no `forItem`
 * check at all, so switching from a failed item A to a fresh item B still showed
 * A's error and A's in-flight `submitting: true` on B's card. Folding every piece
 * of per-item state into one object means one guard (below) protects all of it.
 *
 * `opToken` is the second half of that fix. `forItem` alone tells two *items*
 * apart, but not two *operations* on the SAME item — two submits in flight
 * together, or a submit that outlives an item swap and a swap back. Every call
 * that starts a network write (`settle`) or records a synchronous validation
 * failure (`submit`) mints a new token and stamps it on the state; a completion
 * only applies if the token it captured is still the one in state, so a slower,
 * now-superseded operation's result cannot overwrite a newer one's.
 */
interface ReviewState {
  readonly forItem: string | undefined;
  readonly decisions: Readonly<Record<FieldPath, FieldDecision>>;
  readonly errors: Readonly<Record<FieldPath, string>>;
  readonly submitting: boolean;
  readonly error: Error | undefined;
  readonly opToken: number;
}

/** What a card shows for an item it holds nothing about — including a different one. */
const NOTHING: ReviewState = {
  forItem: undefined,
  decisions: {},
  errors: {},
  submitting: false,
  error: undefined,
  opToken: 0,
};

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
 * 51 leaves and keeps this boundary a real value conversion rather than a type
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
 * Everything here is addressed by dotted leaf path — `"health.healthGasLeak"`, not
 * `"health"` — because an auditor has to be able to accept the ambient-CO result
 * (`"health.healthAmbientCarbonMonoxide"`) while correcting the gas-leak one.
 * `buildReviewRequest` walks `valuesSchema` to decide which leaves exist, so a leaf
 * the model omitted is still presented (with the sentinel envelope) rather than
 * silently missing from the card.
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
 * ## All per-item state is keyed by item id, read through a synchronous guard
 *
 * A queue UI reuses one mounted card for the next parked item, and leaf paths
 * repeat across recordings — so decisions carried over would submit silently,
 * attributing one auditor's correction to another recording. An effect-based
 * reset still leaves one render where the stale decisions are live and
 * submittable, which is one render too many when submit is a click. So `state`
 * is read through a guard (`state.forItem === item?.id`) rather than reset in an
 * effect: the very first render after `item` changes sees `NOTHING`.
 *
 * `decisions` and `errors` are not the only things this protects — `submitting`
 * and `error` live in the same guarded object, for the same reason. A validation
 * failure or an in-flight write belongs to the item that caused it, and must stop
 * being visible the moment the card shows a different one, not linger because it
 * happened to be stored in a `useState` with no notion of "whose" it was.
 */
export function useReview(
  item: OutboxItem | undefined,
  options: UseReviewOptions,
): UseReviewResult {
  const { valuesSchema, requiredOnCreate } = options;
  const outbox = useRiboInstance("outbox", options.outbox);

  const [state, setState] = useState<ReviewState>({
    forItem: item?.id,
    decisions: {},
    errors: {},
    submitting: false,
    error: undefined,
    opToken: 0,
  });
  // Every `settle()` call (a submit that got past validation, or a discard) mints
  // the next value from here before it does anything async — see `ReviewState`'s
  // own note on `opToken`. A ref, not state: it is bookkeeping for deciding
  // whether a *later* write should apply, never a value this hook renders.
  const nextOpToken = useRef(0);

  // Synchronously empty whenever the state belongs to a different item. No effect,
  // no stale window.
  //
  // This hook has no `useEffect` anywhere in it — every derived value here,
  // including this guard, is a plain read computed during render. StrictMode
  // also double-invokes render calculations and `useState` updater functions
  // (not only effect cleanup), so that guarantee matters here too: both are pure
  // in this hook — the guard only reads `state`/`item`, and every updater below
  // is a plain function of its `prior` argument — so calling either twice
  // produces the same result and StrictMode's double-invocation is a no-op.
  const { decisions, errors, submitting, error } = state.forItem === item?.id ? state : NOTHING;

  const request = useMemo<ReviewRequest | undefined>(() => {
    if (item?.extracted === undefined || item.transcript === undefined) return undefined;
    // No cast on the way in: `extracted` is persisted as `Record<string, unknown>`
    // and that is exactly what `buildReviewRequest` takes.
    return buildReviewRequest(item.extracted, item.transcript, valuesSchema, { requiredOnCreate });
  }, [item?.extracted, item?.transcript, valuesSchema, requiredOnCreate]);

  const paths = useMemo<readonly FieldPath[]>(
    () => (request === undefined ? [] : Object.keys(request.fields)),
    [request],
  );

  const setDecision = useCallback(
    (path: FieldPath, decision: FieldDecision) => {
      // A stale or mistyped path must not silently vanish: `submit()` defaults
      // any path missing a decision to "accepted", so recording a decision under
      // a path that is not (or is no longer) a leaf of `request` would silently
      // turn an intended rejection — or edit, or accept — into an acceptance of
      // whatever the model extracted for a leaf nobody actually looked at.
      // Throwing here, at the call that got the path wrong, is the alternative.
      if (request === undefined || !Object.hasOwn(request.fields, path)) {
        throw new Error(`ribo: "${path}" is not a field of this review request.`);
      }
      const id = item?.id;
      setState((prior) => {
        const base = prior.forItem === id ? prior : NOTHING;
        return {
          ...base,
          forItem: id,
          decisions: { ...base.decisions, [path]: decision },
          // Deciding a leaf answers whatever the last submit said about it —
          // including "reject it instead", which is the escape core's own message
          // names for an extracted value that cannot be accepted as it stands.
          errors: withoutPath(base.errors, path),
        };
      });
    },
    [item?.id, request],
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
      const id = item.id;
      // Minted BEFORE the write starts, and stamped on `state` synchronously
      // below — see `ReviewState`'s note on `opToken`. Whichever of this
      // operation's two completions (success or catch) runs, it only applies if
      // this is still the token in state: a second `settle()` on the same item
      // (a resubmit, a discard after a failed submit) bumps the token again, so
      // this one's eventual result — arriving after the newer one has already
      // reported its own — is superseded rather than overwriting it.
      const token = ++nextOpToken.current;
      setState((prior) => {
        const base = prior.forItem === id ? prior : NOTHING;
        return { ...base, forItem: id, submitting: true, error: undefined, opToken: token };
      });
      // Applies the completion only if no newer operation has claimed `state`
      // since — for this item or (via the `forItem` half) any other one.
      const applyIfCurrent = (patch: Partial<ReviewState>) =>
        setState((prior) =>
          prior.forItem === id && prior.opToken === token ? { ...prior, ...patch } : prior,
        );
      try {
        // `toPersisted` is a value conversion, not a cast — see its own note. What
        // gets sent is still structurally identical to `outcome`, and
        // `submitReview` re-parses it regardless.
        await outbox.submitReview(id, toPersisted(outcome));
        applyIfCurrent({ submitting: false });
        return outcome;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        applyIfCurrent({ submitting: false, error: failure });
        throw failure;
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
      // A new token even though this failure never reaches `settle()`'s network
      // write: an EARLIER call's `settle()` may still be in flight (a slow
      // resubmit the human gave up waiting on), and this synchronous failure is a
      // newer, more authoritative result for the same item. Bumping the token
      // here means that earlier call's eventual completion — success or another
      // failure — cannot overwrite the one reported right now.
      const token = ++nextOpToken.current;
      setState((prior) => {
        const base = prior.forItem === id ? prior : NOTHING;
        return {
          ...base,
          forItem: id,
          // REPLACED, not merged: each submit is a complete verdict over every
          // leaf, so a message carried over from an earlier attempt would flag a
          // leaf that is now fine.
          errors: failure instanceof ReviewValidationError ? indexIssues(failure.issues) : {},
          submitting: false,
          error: failure,
          opToken: token,
        };
      });
      // Still thrown. A caller that ignores a refused submission must not carry on
      // as though the review went in; `errors` is for showing it, not for replacing
      // the failure.
      throw failure;
    }

    // Clears any error a PRIOR failed submit on this same item left behind.
    // Per-decision clearing (`setDecision`'s `withoutPath`) cannot be the only
    // mechanism for this: it only fires when a leaf's OWN decision changes, but
    // a leaf can go from invalid to valid with its decision untouched — the
    // adapter's schema for that leaf can loosen between submits (a validation
    // rule can be relaxed) while `decisions` carries over unchanged, since
    // `decisions` is keyed by item, not by which `valuesSchema` produced
    // `request`. `"a schema change on the same item revalidates a stale error
    // without re-deciding the leaf"` in the test file resubmits exactly that
    // shape and fails without this line.
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
