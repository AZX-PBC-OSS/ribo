import { z } from "zod";
import type {
  ExistingRecord,
  FieldDecision,
  FieldDecisions,
  FieldPath,
  InstanceLinkDecision,
  Outbox,
  PersistedReviewOutcome,
  RankedCandidate,
  RequiredOnCreate,
  ReviewFields,
  ReviewIssue,
  ReviewOutcome,
  ReviewRequest,
  ReviewSubmission,
  SessionItem,
  Transcript,
} from "@azx/ribo-core";
import {
  buildReviewRequest,
  parseFieldPath,
  resolveReview,
  ReviewValidationError,
  stripOptionalNullable,
} from "@azx/ribo-core";
import { useCallback, useMemo, useRef, useState } from "react";

import { useOutboxItems } from "./use-outbox-items.js";
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
   * Leaf names grouped by the group that owns the create endpoint — passed straight
   * through to `buildReviewRequest`'s `requiredOnCreate`, so each named leaf on every
   * instance of its group has `ReviewField.required` set to `true`. A card can mark
   * it and refuse a submit that leaves it empty.
   *
   * Hosts pass `adapter.requiredOnCreate` (`ToolAdapter.requiredOnCreate`) here — the
   * same reason `valuesSchema` above takes the schema and not the adapter: this hook
   * needs the one declaration, not the whole `ToolAdapter`. Omitted groups and leaves
   * are simply never required, which is what "the adapter declares nothing" already
   * means on the core side.
   *
   * **Hold it still, like `valuesSchema`.** It is also a `useMemo` dependency; an
   * inline object literal is a new reference every render and rebuilds `fields` on
   * every render along with it.
   */
  readonly requiredOnCreate?: RequiredOnCreate;
  /**
   * Existing records of each collection group, keyed by the group path (e.g. `"hvac"`).
   *
   * These are surfaced at review for a human to link a dictated instance against. They
   * never enter the extraction step; the host supplies them after extraction has produced
   * its grounded values. Absent groups mean no existing records.
   */
  readonly existingRecords?: Readonly<Record<string, readonly ExistingRecord[]>>;
  /**
   * Tool-specific ordering of existing records for one instance.
   *
   * A candidate with a contradicting captured identifying field is demoted to the end of
   * the list; the strongest non-contradicting candidate may be pre-highlighted. The hook
   * never links automatically — this is only for display order.
   */
  readonly rankCandidates?: (
    group: string,
    instance: Record<string, unknown>,
    existing: readonly ExistingRecord[],
  ) => readonly RankedCandidate[];
  /** Bypasses the provider. What the tests inject through. */
  readonly outbox?: Outbox;
}

export interface UseReviewResult {
  /** The session has both a joined transcript and an extraction, so review can proceed. */
  readonly ready: boolean;
  /** Every leaf of `valuesSchema`, by dotted path, in schema-declaration order. */
  readonly fields: ReviewFields | undefined;
  readonly transcript: Transcript | undefined;
  /** `undefined` if the session is not ready, or the path is not a leaf of this review. */
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
  /** Existing records of each collection group, if any were supplied. */
  readonly existingRecords: Readonly<Record<string, readonly ExistingRecord[]>> | undefined;
  /** Groups that appeared in the extracted data as empty arrays, so the card can offer an add affordance. */
  readonly presentButEmpty: readonly string[] | undefined;
  /** The current link-or-create decision for an instance path, or `undefined` if the path is not a known instance. */
  readonly linkDecisionOf: (instancePath: string) => InstanceLinkDecision | undefined;
  /** Decide to link an instance to an existing record. */
  readonly linkInstance: (instancePath: string, uuid: string) => void;
  /** Decide to create a new record for an instance. */
  readonly createInstance: (instancePath: string) => void;
  /** Existing records ordered by the tool-specific contradiction check for an instance, or `undefined` if none. */
  readonly rankedCandidatesOf: (instancePath: string) => readonly RankedCandidate[] | undefined;
  /** Add a new, all-empty instance to a collection group. */
  readonly addInstance: (group: string) => void;
  /** Remove a collection instance and remap the remaining instances' decisions to their new keys. */
  readonly removeInstance: (instancePath: string) => void;
  readonly submit: () => Promise<ReviewOutcome>;
  readonly discard: (reason?: string) => Promise<ReviewOutcome>;
  readonly submitting: boolean;
  readonly error: Error | undefined;
}

/**
 * What this hook remembers, all of it scoped to one session.
 *
 * `submitting` and `error` live here too, alongside `decisions`/`errors`, and not
 * in their own `useState`s — that split is what let them leak across sessions in an
 * earlier version: they were read straight off their own hooks with no `forSession`
 * check at all, so switching from a failed session A to a fresh session B still showed
 * A's error and A's in-flight `submitting: true` on B's card. Folding every piece
 * of per-session state into one object means one guard (below) protects all of it.
 *
 * `opToken` is the second half of that fix. `forSession` alone tells two *sessions*
 * apart, but not two *operations* on the SAME session — two submits in flight
 * together, or a submit that outlives a session swap and a swap back. Every call
 * that starts a network write (`settle`) or records a synchronous validation
 * failure (`submit`) mints a new token and stamps it on the state; a completion
 * only applies if the token it captured is still the one in state, so a slower,
 * now-superseded operation's result cannot overwrite a newer one's.
 */
interface ReviewState {
  readonly forSession: string | undefined;
  /** A local copy of `session.extracted` that may have instances added or removed by the reviewer. */
  readonly extractedSnapshot: Record<string, unknown> | undefined;
  readonly decisions: Readonly<Record<FieldPath, FieldDecision>>;
  readonly instanceLinks: Readonly<Record<string, InstanceLinkDecision>>;
  readonly errors: Readonly<Record<FieldPath, string>>;
  readonly submitting: boolean;
  readonly error: Error | undefined;
  readonly opToken: number;
}

/** What a card shows for a session it holds nothing about — including a different one. */
const NOTHING: ReviewState = {
  forSession: undefined,
  extractedSnapshot: undefined,
  decisions: {},
  instanceLinks: {},
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
const toPersisted = (outcome: ReviewOutcome): PersistedReviewOutcome => {
  if (outcome.status === "discarded") return outcome;
  const mutable =
    outcome.status === "accepted"
      ? { status: "accepted" as const, fields: { ...outcome.fields } }
      : {
          status: "edited" as const,
          fields: { ...outcome.fields },
          editedFields: [...outcome.editedFields],
          rejectedFields: [...outcome.rejectedFields],
        };
  if (outcome.linkTargets) {
    return {
      ...mutable,
      linkTargets: Object.fromEntries(
        Object.entries(outcome.linkTargets).map(([group, targets]) => [group, [...targets]]),
      ),
    };
  }
  return mutable;
};

// ---------------------------------------------------------------------------
// Instance add/remove helpers
// ---------------------------------------------------------------------------

/** Deep clone a plain-JSON extraction so the local snapshot can be mutated safely. */
const cloneExtracted = (extracted: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(extracted)) as Record<string, unknown>;

/** Append an all-empty instance to `extracted[group]`, creating the array if absent. */
const addInstanceToSnapshot = (
  extracted: Record<string, unknown>,
  group: string,
): Record<string, unknown> => {
  const clone = cloneExtracted(extracted);
  const current = clone[group];
  clone[group] = Array.isArray(current) ? [...current, {}] : [{}];
  return clone;
};

/** Remove the instance at `index` from `extracted[group]`. */
const removeInstanceFromSnapshot = (
  extracted: Record<string, unknown>,
  group: string,
  index: number,
): Record<string, unknown> => {
  const clone = cloneExtracted(extracted);
  const current = clone[group];
  if (Array.isArray(current)) {
    clone[group] = current.filter((_, i) => i !== index);
  }
  return clone;
};

const INSTANCE_KEY_RE = /^k(\d+)$/;

const instanceKeyToIndex = (key: string): number | undefined => {
  const match = INSTANCE_KEY_RE.exec(key);
  return match === null || match[1] === undefined ? undefined : Number.parseInt(match[1], 10) - 1;
};

const indexToInstanceKey = (index: number): string => `k${index + 1}`;

/**
 * After removing the instance at `removedIndex` from a collection group, re-key
 * any stored decisions/errors/links that addressed later instances so they still
 * attach to the same physical instance. Decisions for the removed instance are
 * dropped.
 */
const remapAfterInstanceRemove = <T>(
  map: Readonly<Record<string, T>>,
  group: string,
  removedIndex: number,
): Record<string, T> => {
  const remapped: Record<string, T> = {};
  const prefix = `${group}[`;
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(prefix)) {
      remapped[key] = value;
      continue;
    }
    const closeBracket = key.indexOf("]", prefix.length);
    if (closeBracket === -1) {
      remapped[key] = value;
      continue;
    }
    const keyPart = key.slice(prefix.length, closeBracket);
    const index = instanceKeyToIndex(keyPart);
    if (index === undefined) {
      remapped[key] = value;
      continue;
    }
    if (index === removedIndex) {
      // Drop anything that belonged to the removed instance.
      continue;
    }
    const newIndex = index > removedIndex ? index - 1 : index;
    const newKey = `${prefix}${indexToInstanceKey(newIndex)}${key.slice(closeBracket)}`;
    remapped[newKey] = value;
  }
  return remapped;
};

/**
 * Field-by-field review of one parked session.
 *
 * ```tsx
 * const { fields, decisionOf, edit, reject, errors, submit } = useReview(session, {
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
 * ## The transcript is joined from the session's recordings
 *
 * A session owns extraction; its recordings own their transcripts. The hook calls
 * {@link useOutboxItems} with `sessionId` to fetch the session's recordings, joins
 * their transcript text in capture order, and synthesises a single `Transcript`
 * (`engine: "joined"`) for `buildReviewRequest`. `ready` is false until both the
 * session's `extracted` and at least one recording's transcript are present.
 *
 * ## All per-session state is keyed by session id, read through a synchronous guard
 *
 * A queue UI reuses one mounted card for the next parked session, and leaf paths
 * repeat across recordings — so decisions carried over would submit silently,
 * attributing one auditor's correction to another session. An effect-based
 * reset still leaves one render where the stale decisions are live and
 * submittable, which is one render too many when submit is a click. So `state`
 * is read through a guard (`state.forSession === session?.id`) rather than reset in an
 * effect: the very first render after `session` changes sees `NOTHING`.
 *
 * `decisions` and `errors` are not the only things this protects — `submitting`
 * and `error` live in the same guarded object, for the same reason. A validation
 * failure or an in-flight write belongs to the session that caused it, and must stop
 * being visible the moment the card shows a different one, not linger because it
 * happened to be stored in a `useState` with no notion of "whose" it was.
 */
export function useReview(
  session: SessionItem | undefined,
  options: UseReviewOptions,
): UseReviewResult {
  const { valuesSchema, requiredOnCreate, existingRecords, rankCandidates } = options;
  const outbox = useRiboInstance("outbox", options.outbox);

  // Fetch the session's recordings so the hook can join their transcripts. A
  // sentinel sessionId ensures no recordings match when there is no session,
  // rather than the empty-query default of "every recording in the outbox".
  const { items: recordings } = useOutboxItems(
    { sessionId: session?.id ?? "__no-session__" },
    outbox,
  );

  const [state, setState] = useState<ReviewState>({
    forSession: session?.id,
    extractedSnapshot: undefined,
    decisions: {},
    instanceLinks: {},
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

  // Synchronously empty whenever the state belongs to a different session. No effect,
  // no stale window.
  //
  // This hook has no `useEffect` anywhere in it — every derived value here,
  // including this guard, is a plain read computed during render. StrictMode
  // also double-invokes render calculations and `useState` updater functions
  // (not only effect cleanup), so that guarantee matters here too: both are pure
  // in this hook — the guard only reads `state`/`session`, and every updater below
  // is a plain function of its `prior` argument — so calling either twice
  // produces the same result and StrictMode's double-invocation is a no-op.
  const { extractedSnapshot, decisions, instanceLinks, errors, submitting, error } =
    state.forSession === session?.id ? state : NOTHING;

  // Join the transcript text of every transcribed recording belonging to this
  // session, in capture order (seq-ascending). A synthetic `Transcript` carries
  // the joined text into `buildReviewRequest`; `undefined` until at least one
  // recording has a transcript, so `ready` stays false until the join has content.
  const transcript = useMemo<Transcript | undefined>(() => {
    if (session?.id === undefined) return undefined;
    const withTranscripts = recordings
      .filter((r) => r.transcript !== undefined)
      .sort((a, b) => a.seq - b.seq);
    if (withTranscripts.length === 0) return undefined;
    const text = withTranscripts.map((r) => r.transcript!.text).join(" ");
    return { recordingId: session.id, text, engine: "joined" };
  }, [recordings, session?.id]);

  const request = useMemo<ReviewRequest | undefined>(() => {
    if (session?.extracted === undefined || transcript === undefined) return undefined;
    // Use the local snapshot if the reviewer has added or removed instances;
    // otherwise fall back to the persisted extraction. The snapshot is kept in
    // per-session state and resets when the session changes.
    const extracted = extractedSnapshot ?? session.extracted;
    return buildReviewRequest(extracted, transcript, valuesSchema, {
      requiredOnCreate,
      existingRecords,
    });
  }, [
    extractedSnapshot,
    session?.extracted,
    transcript,
    valuesSchema,
    requiredOnCreate,
    existingRecords,
  ]);

  const paths = useMemo<readonly FieldPath[]>(
    () => (request === undefined ? [] : Object.keys(request.fields)),
    [request],
  );

  const instancePaths = useMemo<ReadonlySet<string>>(() => {
    if (request === undefined) return new Set();
    const paths = new Set<string>();
    for (const leafPath of Object.keys(request.fields)) {
      const segments = parseFieldPath(leafPath);
      let currentPath = "";
      for (const segment of segments) {
        currentPath =
          currentPath === ""
            ? segment.kind === "objectKey"
              ? segment.key
              : `[${segment.key}]`
            : segment.kind === "objectKey"
              ? `${currentPath}.${segment.key}`
              : `${currentPath}[${segment.key}]`;
        if (segment.kind === "instanceKey") {
          paths.add(currentPath);
        }
      }
    }
    return paths;
  }, [request]);

  const instanceDetails = useMemo<
    ReadonlyMap<
      string,
      { readonly group: string; readonly key: string; readonly fields: Record<string, unknown> }
    >
  >(() => {
    if (request === undefined) return new Map();
    const details = new Map<
      string,
      { readonly group: string; readonly key: string; readonly fields: Record<string, unknown> }
    >();
    for (const path of instancePaths) {
      const segments = parseFieldPath(path);
      const group = segments[0]?.key ?? "";
      const key = segments[1]?.key ?? "";
      const prefix = `${path}.`;
      const fields: Record<string, unknown> = {};
      for (const [leafPath, field] of Object.entries(request.fields)) {
        if (leafPath.startsWith(prefix)) {
          fields[leafPath.slice(prefix.length)] = field.extracted.value;
        }
      }
      details.set(path, { group, key, fields });
    }
    return details;
  }, [instancePaths, request]);

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
      const id = session?.id;
      setState((prior) => {
        const base = prior.forSession === id ? prior : NOTHING;
        return {
          ...base,
          forSession: id,
          decisions: { ...base.decisions, [path]: decision },
          // Deciding a leaf answers whatever the last submit said about it —
          // including "reject it instead", which is the escape core's own message
          // names for an extracted value that cannot be accepted as it stands.
          errors: withoutPath(base.errors, path),
        };
      });
    },
    [session?.id, request],
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

  const setInstanceLink = useCallback(
    (instancePath: string, decision: InstanceLinkDecision) => {
      // A stale or mistyped instance path must not silently attach a link to a
      // different instance. Throwing at the call site keeps the error local to the UI
      // control that produced it.
      if (!instancePaths.has(instancePath)) {
        throw new Error(
          `ribo: "${instancePath}" is not a collection instance of this review request.`,
        );
      }
      const id = session?.id;
      setState((prior) => {
        const base = prior.forSession === id ? prior : NOTHING;
        return {
          ...base,
          forSession: id,
          instanceLinks: { ...base.instanceLinks, [instancePath]: decision },
          // A decision answers whatever the last submit said about this instance;
          // errors are per-leaf, not per-instance, so leave them alone.
          errors: base.errors,
        };
      });
    },
    [session?.id, instancePaths],
  );

  const linkInstance = useCallback(
    (instancePath: string, uuid: string) => setInstanceLink(instancePath, { kind: "link", uuid }),
    [setInstanceLink],
  );

  const createInstance = useCallback(
    (instancePath: string) => setInstanceLink(instancePath, { kind: "create" }),
    [setInstanceLink],
  );

  const linkDecisionOf = useCallback(
    (instancePath: string): InstanceLinkDecision | undefined => {
      if (!instancePaths.has(instancePath)) return undefined;
      return instanceLinks[instancePath] ?? { kind: "create" };
    },
    [instanceLinks, instancePaths],
  );

  const rankedCandidatesOf = useCallback(
    (instancePath: string): readonly RankedCandidate[] | undefined => {
      if (rankCandidates === undefined || request === undefined) return undefined;
      const detail = instanceDetails.get(instancePath);
      if (detail === undefined) return undefined;
      const existing = request.existingRecords[detail.group] ?? [];
      if (existing.length === 0) return undefined;
      return rankCandidates(detail.group, detail.fields, existing);
    },
    [instanceDetails, rankCandidates, request],
  );

  const addInstance = useCallback(
    (group: string) => {
      if (request === undefined) {
        throw new Error("ribo: cannot add an instance to a review that is not ready.");
      }
      const groupField = valuesSchema.shape[group];
      if (groupField === undefined) {
        throw new Error(`ribo: "${group}" is not a group of this review schema.`);
      }
      const stripped = stripOptionalNullable(groupField);
      if (!(stripped instanceof z.ZodArray)) {
        throw new Error(
          `ribo: "${group}" is not a collection group and cannot have instances added.`,
        );
      }
      const id = session?.id;
      setState((prior) => {
        const base = prior.forSession === id ? prior : NOTHING;
        const snapshot = base.extractedSnapshot ?? session?.extracted;
        if (snapshot === undefined) {
          throw new Error("ribo: cannot add an instance to a review with no extracted data.");
        }
        return {
          ...base,
          forSession: id,
          extractedSnapshot: addInstanceToSnapshot(snapshot, group),
        };
      });
    },
    [session?.id, session?.extracted, request, valuesSchema],
  );

  const removeInstance = useCallback(
    (instancePath: string) => {
      if (!instancePaths.has(instancePath)) {
        throw new Error(
          `ribo: "${instancePath}" is not a collection instance of this review request.`,
        );
      }
      const segments = parseFieldPath(instancePath);
      const [first, second] = segments;
      if (
        segments.length !== 2 ||
        first === undefined ||
        first.kind !== "objectKey" ||
        second === undefined ||
        second.kind !== "instanceKey"
      ) {
        throw new Error(`ribo: "${instancePath}" is not a valid instance path.`);
      }
      const group = first.key;
      const key = second.key;
      const index = instanceKeyToIndex(key);
      if (index === undefined) {
        throw new Error(`ribo: instance key "${key}" is not a positional key.`);
      }
      const id = session?.id;
      setState((prior) => {
        const base = prior.forSession === id ? prior : NOTHING;
        const snapshot = base.extractedSnapshot ?? session?.extracted;
        if (snapshot === undefined) {
          throw new Error("ribo: cannot remove an instance from a review with no extracted data.");
        }
        const groupArray = snapshot[group];
        if (!Array.isArray(groupArray) || index < 0 || index >= groupArray.length) {
          throw new Error(`ribo: cannot remove instance "${instancePath}" — it no longer exists.`);
        }
        return {
          ...base,
          forSession: id,
          extractedSnapshot: removeInstanceFromSnapshot(snapshot, group, index),
          decisions: remapAfterInstanceRemove(base.decisions, group, index),
          instanceLinks: remapAfterInstanceRemove(base.instanceLinks, group, index),
          errors: remapAfterInstanceRemove(base.errors, group, index),
        };
      });
    },
    [instancePaths, session?.id, session?.extracted],
  );

  const untouched = useMemo(
    () => paths.filter((path) => decisions[path] === undefined),
    [decisions, paths],
  );

  const settle = useCallback(
    async (outcome: ReviewOutcome): Promise<ReviewOutcome> => {
      if (session === undefined) throw new Error("ribo: cannot submit a review with no session.");
      const id = session.id;
      // Minted BEFORE the write starts, and stamped on `state` synchronously
      // below — see `ReviewState`'s note on `opToken`. Whichever of this
      // operation's two completions (success or catch) runs, it only applies if
      // this is still the token in state: a second `settle()` on the same session
      // (a resubmit, a discard after a failed submit) bumps the token again, so
      // this one's eventual result — arriving after the newer one has already
      // reported its own — is superseded rather than overwriting it.
      const token = ++nextOpToken.current;
      setState((prior) => {
        const base = prior.forSession === id ? prior : NOTHING;
        return { ...base, forSession: id, submitting: true, error: undefined, opToken: token };
      });
      // Applies the completion only if no newer operation has claimed `state`
      // since — for this session or (via the `forSession` half) any other one.
      const applyIfCurrent = (patch: Partial<ReviewState>) =>
        setState((prior) =>
          prior.forSession === id && prior.opToken === token ? { ...prior, ...patch } : prior,
        );
      try {
        // `toPersisted` is a value conversion, not a cast — see its own note. What
        // gets sent is still structurally identical to `outcome`, and
        // `submitSessionReview` re-parses it regardless.
        await outbox.submitSessionReview(id, toPersisted(outcome));
        applyIfCurrent({ submitting: false });
        return outcome;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        applyIfCurrent({ submitting: false, error: failure });
        throw failure;
      }
    },
    [session, outbox],
  );

  const submit = useCallback(async (): Promise<ReviewOutcome> => {
    if (request === undefined) throw new Error("ribo: this session is not ready for review.");
    const id = session?.id;
    // A decision for every leaf, defaulting to accepted. This is what makes
    // `resolveReview`'s completeness check pass; the check, not this line, is the
    // guarantee.
    const complete: FieldDecisions = Object.fromEntries(
      paths.map((path) => [path, decisions[path] ?? { status: "accepted" }]),
    );

    // Drop any link decisions that refer to instances that no longer exist in the
    // current request (e.g., after a remove). The safe default is create, so omitting
    // a stale decision lets it fall back rather than leak a link to a removed instance.
    const submissionInstanceLinks: Record<string, InstanceLinkDecision> = Object.fromEntries(
      Object.entries(instanceLinks).filter(([path]) => instancePaths.has(path)),
    );
    const hasInstanceLinks = Object.keys(submissionInstanceLinks).length > 0;
    const submission: ReviewSubmission = {
      status: "submitted",
      decisions: complete,
      ...(hasInstanceLinks ? { instanceLinks: submissionInstanceLinks } : {}),
    };

    let outcome: ReviewOutcome;
    try {
      outcome = resolveReview(request, submission);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      // A new token even though this failure never reaches `settle()`'s network
      // write: an EARLIER call's `settle()` may still be in flight (a slow
      // resubmit the human gave up waiting on), and this synchronous failure is a
      // newer, more authoritative result for the same session. Bumping the token
      // here means that earlier call's eventual completion — success or another
      // failure — cannot overwrite the one reported right now.
      const token = ++nextOpToken.current;
      setState((prior) => {
        const base = prior.forSession === id ? prior : NOTHING;
        return {
          ...base,
          forSession: id,
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

    // Clears any error a PRIOR failed submit on this same session left behind.
    // Per-decision clearing (`setDecision`'s `withoutPath`) cannot be the only
    // mechanism for this: it only fires when a leaf's OWN decision changes, but
    // a leaf can go from invalid to valid with its decision untouched — the
    // adapter's schema for that leaf can loosen between submits (a validation
    // rule can be relaxed) while `decisions` carries over unchanged, since
    // `decisions` is keyed by session, not by which `valuesSchema` produced
    // `request`. `"a schema change on the same session revalidates a stale error
    // without re-deciding the leaf"` in the test file resubmits exactly that
    // shape and fails without this line.
    setState((prior) => (prior.forSession === id ? { ...prior, errors: {} } : prior));
    return await settle(outcome);
  }, [decisions, instanceLinks, instancePaths, session?.id, paths, request, settle]);

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
    existingRecords: request?.existingRecords,
    presentButEmpty: request?.presentButEmpty,
    linkDecisionOf,
    linkInstance,
    createInstance,
    rankedCandidatesOf,
    addInstance,
    removeInstance,
    submit,
    discard,
    submitting,
    error,
  };
}
