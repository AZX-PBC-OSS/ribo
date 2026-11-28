/**
 * @file The corpus proposal engine: one case's unanswered leaves in, pending
 * expectation entries out, over an injected chat transport.
 *
 * The engine is pure — transport, model identity and clock are injected, and
 * no call is made when the case has no unanswered leaf. The model speaks the
 * flat proposal language (`propose-language.ts`); code owns the paths, the
 * grounding and the pivot to expectation entries:
 *
 * - every quoted value is matched per input, never against the joined text,
 *   under the one rule `schema-init/validate.ts` applies; the earliest
 *   matching input in declared order is recorded, and the input name is
 *   derived from that match — never taken from the model, which is never
 *   asked for one;
 * - a value of the wrong kind, outside a leaf's declared vocabulary, on an
 *   unknown path or with an ungrounded quote is never written: the item is
 *   dropped and the leaf is named, with the reason, in the report's
 *   unproposed list — one bad quote among a hundred values never discards the
 *   reviewer-usable rest;
 * - collection cells pivot to the ordinal-keyed, leaf-major shape the scorer
 *   reads (`ordinalValues` in `eval/score-cell.ts`, read back through the
 *   scorer's array-transparent `readProducedLeaf`): rows in document order
 *   become flat ordinals, a leaf missing from one row omits that ordinal, and
 *   a leaf missing from every row — or an empty collection — is a proposed
 *   absence.
 *
 * There is one bounded repair round, and it answers only an unparseable
 * reply; after it, a still-unparseable reply fails that case alone. The
 * manifest's instructions are not sent.
 */
import type { ChatClient, LeafInventoryEntry } from "@azx/ribo-core";
import type { z } from "zod";

import type { CaseInputText } from "../eval/case-text.js";
import { matchingQuoteInputs } from "../schema-init/validate.js";
import { walkCollectionPaths } from "./collection-paths.js";
import type { ProposeReply, ProposeValue } from "./propose-language.js";
import { dropProposeReplyNulls, proposeReplySchema } from "./propose-language.js";
import { initialProposePrompt, repairProposePrompt } from "./propose-prompt.js";
export type { ProposePromptLeaf } from "./propose-prompt.js";
import type { ProposePromptLeaf } from "./propose-prompt.js";
import type { ExpectationEntry, ExpectationValue, ProposalEvidence } from "./case.js";

/**
 * The semantic repair bound shared by the engine and its command's spend
 * estimate: one repair round after an unparseable initial reply.
 */
export const PROPOSE_REPAIRS = 1;

/**
 * Transport, model identity and time, injected — the engine has no capacity
 * to authenticate and never reads the system clock when one is given.
 */
export interface ProposeCaseOptions {
  /** The stub or prepared operator transport that proposes answers. */
  readonly chat: ChatClient;
  /** Model name sent on the initial and repair requests and on every proposal. */
  readonly model: string;
  /** Backend name stamped on every pending proposal's provenance. */
  readonly backend: string;
  /** Completion clock, read at most once and only for a parsed reply. */
  readonly clock?: () => Date;
}

/** One asked leaf the proposal could not answer, with the first reason why. */
export interface ProposeUnproposedLeaf {
  /** The leaf path — or, for an unknown path, the path the model named. */
  readonly path: string;
  /** Why no pending proposal was written for it. */
  readonly reason: string;
}

/** A proposed case: pending entries keyed by leaf path, and the unproposed rest. */
export interface ProposedCase {
  readonly success: true;
  /** Pending expectation entries, keyed by the leaf path the case file uses. */
  readonly entries: Readonly<Record<string, ExpectationEntry>>;
  /** The asked leaves no entry was written for, each with its reason. */
  readonly unproposed: readonly ProposeUnproposedLeaf[];
}

/** A failed case: the proposal round produced no parsable reply at all. */
export interface FailedProposeCase {
  readonly success: false;
  /** What the last reply got wrong, after the repair bound was exhausted. */
  readonly reason: string;
}

/** The result of one case's proposal round. */
export type ProposeCaseResult = ProposedCase | FailedProposeCase;

/**
 * One case's proposal round: the schema and its inventory, the leaves to ask,
 * the case's inputs and text, and the injected transport options.
 * @category Eval
 */
export interface ProposeCaseParams {
  /** The corpus's converted zod schema — walked for collection membership. */
  readonly schema: z.ZodObject;
  /** The schema's leaves, as the one field inventory reports them. */
  readonly leafInventory: readonly LeafInventoryEntry[];
  /** The unanswered leaf paths to ask for, in the order the report reads. */
  readonly unanswered: readonly string[];
  /** The case's ordered input texts — evidence is matched per input. */
  readonly inputs: readonly CaseInputText[];
  /** The case's combined text, as `caseTextOf` joins it. */
  readonly caseText: string;
  /** The corpus's schema document, sent in the prompt. */
  readonly schemaDocument: unknown;
  /** Transport, model identity and time. */
  readonly options: ProposeCaseOptions;
}

interface LeafInfo {
  readonly entry: LeafInventoryEntry;
  readonly collectionPath?: string;
}

/** Parse one reply, reporting parse problems without failing anything yet. */
const parseReply = (
  content: string,
):
  | { readonly ok: true; readonly reply: ProposeReply }
  | { readonly ok: false; readonly problems: readonly string[] } => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`response: malformed JSON (${detail})`] };
  }
  const parsed = proposeReplySchema.safeParse(dropProposeReplyNulls(value));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const at = issue.path.length === 0 ? "response" : issue.path.join(".");
      return `${at}: ${issue.message}`;
    });
    return { ok: false, problems };
  }
  return { ok: true, reply: parsed.data };
};

/** Does the value's kind satisfy the leaf's kind and declared vocabulary? */
const kindAllows = (leaf: LeafInventoryEntry, value: ProposeValue): boolean => {
  switch (leaf.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (leaf.values ?? []).includes(value);
    case "literal":
      return (leaf.values ?? []).includes(value);
  }
};

/** Why the value's kind does not satisfy the leaf. */
const kindReason = (leaf: LeafInventoryEntry, value: ProposeValue): string => {
  const rendered = JSON.stringify(value);
  if (leaf.kind === "enum") {
    const members = (leaf.values ?? []).map((member) => JSON.stringify(member)).join(", ");
    return `value ${rendered} is not a member of the leaf's enum (${members}) — a value outside the declared vocabulary is never written`;
  }
  if (leaf.kind === "literal") {
    const members = (leaf.values ?? []).map((member) => JSON.stringify(member)).join(", ");
    return `value ${rendered} is not the leaf's literal (${members})`;
  }
  return `value ${rendered} is not a ${leaf.kind} value — the leaf's kind is "${leaf.kind}"`;
};

/** Why the quote grounds nowhere: the per-input rules, stated once. */
const ungroundedReason = (quote: string): string =>
  `quote ${JSON.stringify(quote)} was not found in any input — text and transcript inputs match ` +
  "exactly, document inputs under the layout fold, and a quote never spans inputs";

/** The earliest declared input whose own rule accepts the quote, as an evidence link. */
const groundQuote = (
  quote: string,
  inputs: readonly CaseInputText[],
): ProposalEvidence | undefined => {
  const first = matchingQuoteInputs(quote, inputs)[0];
  return first === undefined ? undefined : { quote, input: first.file };
};

/**
 * The asked leaves as the prompt renders them, in asked order — the ONE
 * prompt-leaf construction, shared by the engine and by the command's spend
 * estimate, so the estimate prices the request the engine actually sends.
 */
export function proposePromptLeaves(
  schema: z.ZodObject,
  leafInventory: readonly LeafInventoryEntry[],
  askedPaths: readonly string[],
): readonly ProposePromptLeaf[] {
  const collectionPathByLeaf = new Map<string, string | undefined>(
    walkCollectionPaths(schema).map((entry) => [entry.path, entry.collectionPath]),
  );
  return askedPaths.flatMap((path) => {
    const entry = leafInventory.find((candidate) => candidate.path === path);
    if (entry === undefined) return [];
    const collectionPath = collectionPathByLeaf.get(path);
    return [
      {
        path,
        kind: entry.kind,
        ...(entry.values === undefined ? {} : { values: entry.values }),
        ...(collectionPath === undefined ? {} : { collectionPath }),
      },
    ];
  });
}

/**
 * Propose one case's answers: one initial call, at most one bounded repair
 * round for an unparseable reply, then code-owned validation and the pivot
 * into pending expectation entries. Item-level problems never fail the case —
 * they leave the leaf unanswered, named in the unproposed list.
 */
export async function proposeCase(params: ProposeCaseParams): Promise<ProposeCaseResult> {
  const { options } = params;
  // A case with no unanswered leaf spends nothing: zero calls is the contract.
  if (params.unanswered.length === 0) return { success: true, entries: {}, unproposed: [] };

  const collectionPathByLeaf = new Map<string, string | undefined>(
    walkCollectionPaths(params.schema).map((entry) => [entry.path, entry.collectionPath]),
  );
  const leavesByPath = new Map<string, LeafInfo>(
    params.leafInventory.map((entry) => [
      entry.path,
      { entry, collectionPath: collectionPathByLeaf.get(entry.path) },
    ]),
  );
  const askedPaths = [...new Set(params.unanswered)];
  const asked = new Set(askedPaths);

  const promptLeaves = proposePromptLeaves(params.schema, params.leafInventory, askedPaths);

  const base = initialProposePrompt({
    model: options.model,
    schemaDocument: params.schemaDocument,
    leaves: promptLeaves,
    caseText: params.caseText,
  });

  let request = base;
  let lastProblems: readonly string[] = [];
  for (let repair = 0; repair <= PROPOSE_REPAIRS; repair++) {
    const completion = await options.chat.complete(request);
    const parsed = parseReply(completion.content);
    if (parsed.ok) return validateReply(parsed.reply);
    lastProblems = parsed.problems;
    if (repair < PROPOSE_REPAIRS) {
      request = repairProposePrompt(base, parsed.problems, repair + 1);
    }
  }
  return {
    success: false,
    reason:
      `the proposal round exhausted its ${PROPOSE_REPAIRS} repair round(s) without a parsable ` +
      `reply; no entry was written for any leaf. Last problems: ${lastProblems.join("; ")}`,
  };

  /** Validate the one parsed reply against the schema and the case's inputs, and pivot it. */
  function validateReply(reply: ProposeReply): ProposedCase {
    const proposedAt = (options.clock ?? (() => new Date()))().toISOString();
    const problems = new Map<string, string>();
    const entries = new Map<string, ExpectationEntry>();
    const absent = new Set<string>();
    const cells = new Map<
      string,
      { values: Record<string, ExpectationValue>; evidence: Record<string, ProposalEvidence> }
    >();
    const rowsByPath = new Map<string, number>();

    const problem = (path: string, reason: string): void => {
      if (!problems.has(path)) problems.set(path, reason);
    };
    const absence = (): ExpectationEntry => ({
      status: "declared-absent",
      proposal: {
        status: "declared-absent",
        backend: options.backend,
        model: options.model,
        proposedAt,
      },
      review: "pending",
    });
    const asserted = (
      value: ExpectationValue,
      evidence: ProposalEvidence | Record<string, ProposalEvidence>,
    ): ExpectationEntry => ({
      status: "asserted",
      value,
      proposal: {
        status: "asserted",
        value,
        evidence,
        backend: options.backend,
        model: options.model,
        proposedAt,
      },
      review: "pending",
    });
    const notAskedReason =
      "it is not among the leaves asked — only the case's unanswered leaves are proposed";

    for (const item of reply.items) {
      const info = leavesByPath.get(item.path);
      if (info === undefined) {
        problem(item.path, `unknown path — it is not a leaf of the corpus's schema`);
        continue;
      }
      if (info.collectionPath !== undefined) {
        problem(
          item.path,
          `it is a collection leaf under "${info.collectionPath}" — a leaf under a collection ` +
            "is answered in that collection's rows, not in items",
        );
        continue;
      }
      if (!asked.has(item.path)) {
        problem(item.path, notAskedReason);
        continue;
      }
      if (entries.has(item.path) || absent.has(item.path)) continue;
      const quote = item.quote;
      const hasQuote = typeof quote === "string" && quote.trim().length > 0;
      if (item.absent === true) {
        if ((item.value !== undefined && item.value !== null) || hasQuote) {
          problem(item.path, "it names both a value and an absence — exactly one of the two");
          continue;
        }
        absent.add(item.path);
        continue;
      }
      if (item.value === undefined || item.value === null) {
        problem(item.path, "it names neither a value with its quote nor an absence");
        continue;
      }
      if (typeof quote !== "string" || quote.trim().length === 0) {
        problem(item.path, "it carries a value without a non-empty quote");
        continue;
      }
      const value = item.value;
      if (!kindAllows(info.entry, value)) {
        problem(item.path, kindReason(info.entry, value));
        continue;
      }
      const evidence = groundQuote(quote, params.inputs);
      if (evidence === undefined) {
        problem(item.path, `its quote does not ground: ${ungroundedReason(quote)}`);
        continue;
      }
      entries.set(item.path, asserted(value, evidence));
    }

    for (const collection of reply.collections) {
      const start = rowsByPath.get(collection.path) ?? 0;
      rowsByPath.set(collection.path, start + collection.rows.length);
      const underCollection = askedPaths.some(
        (path) => leavesByPath.get(path)?.collectionPath === collection.path,
      );
      collection.rows.forEach((row, rowIndex) => {
        const ordinal = String(start + rowIndex);
        for (const cell of row.cells) {
          const info = leavesByPath.get(cell.leaf);
          if (info === undefined) {
            problem(cell.leaf, `unknown path — it is not a leaf of the corpus's schema`);
            continue;
          }
          if (info.collectionPath !== collection.path) {
            problem(
              cell.leaf,
              `it is answered in the rows of its nearest collection ` +
                `"${info.collectionPath ?? "none — it is a scalar leaf"}", not under "${collection.path}"`,
            );
            continue;
          }
          if (!asked.has(cell.leaf)) {
            problem(cell.leaf, notAskedReason);
            continue;
          }
          if (entries.has(cell.leaf) || absent.has(cell.leaf)) continue;
          if (cell.value === undefined || cell.value === null) {
            problem(cell.leaf, `its cell in row ${ordinal} carries no value`);
            continue;
          }
          if (typeof cell.quote !== "string" || cell.quote.trim().length === 0) {
            problem(cell.leaf, `its cell in row ${ordinal} carries no non-empty quote`);
            continue;
          }
          if (!kindAllows(info.entry, cell.value)) {
            problem(cell.leaf, kindReason(info.entry, cell.value));
            continue;
          }
          const evidence = groundQuote(cell.quote, params.inputs);
          if (evidence === undefined) {
            problem(
              cell.leaf,
              `its cell in row ${ordinal} does not ground: ${ungroundedReason(cell.quote)}`,
            );
            continue;
          }
          let bucket = cells.get(cell.leaf);
          if (bucket === undefined) {
            bucket = { values: {}, evidence: {} };
            cells.set(cell.leaf, bucket);
          }
          bucket.values[ordinal] = cell.value;
          bucket.evidence[ordinal] = evidence;
        }
      });
      if (!underCollection) {
        // The model named a collection the asked leaves do not live under:
        // its rows said nothing answerable, so nothing under it is written.
        problem(
          collection.path,
          `it is not the collection of any asked leaf — a collection entry must name the ` +
            "nearest array ancestor of the leaves it answers, as the prompt lists it",
        );
      }
    }

    const out: Record<string, ExpectationEntry> = {};
    const unproposed: { path: string; reason: string }[] = [];
    for (const path of askedPaths) {
      const entry = entries.get(path);
      if (entry !== undefined) {
        out[path] = entry;
        continue;
      }
      if (absent.has(path)) {
        out[path] = absence();
        continue;
      }
      const bucket = cells.get(path);
      if (bucket !== undefined && Object.keys(bucket.values).length > 0) {
        out[path] = asserted(bucket.values, bucket.evidence);
        continue;
      }
      const reason = problems.get(path);
      if (reason !== undefined) {
        unproposed.push({ path, reason });
        continue;
      }
      // The model was silent about the leaf — a proposed absence, never a
      // silent skip.
      out[path] = absence();
    }
    // Problems on paths outside the asked set (unknown paths, unasked leaves)
    // belong in the report too: the model spoke and code refused.
    for (const [path, reason] of problems) {
      if (!asked.has(path)) unproposed.push({ path, reason });
    }
    return { success: true, entries: out, unproposed };
  }
}
