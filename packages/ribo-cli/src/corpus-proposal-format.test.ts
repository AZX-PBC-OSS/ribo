/**
 * @file The proposal-and-review case format's tests (ADR 0049): what parses,
 * what the loader refuses, and how `resolveExpectation` classifies an entry.
 *
 * The suites are schema- and loader-driven — no model, no network, no
 * credential. The loader's negative tests copy the shipped example corpus
 * into a fresh temp directory and break exactly one thing, the
 * `corpus-loader.test.ts` pattern.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import {
  CorpusCaseSchema,
  ExpectationProposalSchema,
  ProposalEvidenceSchema,
  resolveExpectation,
} from "./index.js";
import type { ExpectationEntry, ExpectationReviewClass } from "./index.js";
import { CorpusError } from "./corpus/error.js";
import { describeIssues } from "./corpus/issues.js";
import { loadCorpus } from "./corpus/loader.js";

/** The shipped example corpus — scalar leaves beside a collection's. */
const EXAMPLE_CORPUS = fileURLToPath(new URL("../examples/basic-corpus", import.meta.url));

/** The temp directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

/** Copy the example corpus into a fresh temp directory, break one thing, and hand it over. */
const brokenCorpus = (breakOne: (dir: string) => void): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-proposal-"));
  temporaries.push(dir);
  cpSync(EXAMPLE_CORPUS, dir, { recursive: true });
  breakOne(dir);
  return dir;
};

/** Edit one copied corpus file's JSON in place. */
const editJson = (file: string, edit: (document: Record<string, unknown>) => void): void => {
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
};

/** The message of the refusal a broken corpus earns. */
const refusal = (dir: string): string => {
  try {
    loadCorpus(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusError);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the broken corpus loaded instead of being refused");
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An asserted proposal, as propose would stamp it. */
const proposal = (overrides?: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  status: "asserted",
  value: "gas",
  evidence: { quote: "runs on gas", input: "input.txt" },
  backend: "http",
  model: "proposer-1",
  proposedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

/** A pending asserted entry wrapping the given proposal. */
const pendingEntry = (proposalBlock: Record<string, unknown>): Record<string, unknown> => ({
  status: "asserted",
  value: "gas",
  proposal: proposalBlock,
  review: "pending",
});

/** A confirmed entry over the given proposal, with the entry's own fields. */
const confirmedEntry = (
  proposalBlock: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => ({ proposal: proposalBlock, review: "confirmed", ...entry });

test("a pending and a confirmed proposal-bearing entry parse, and a proposal-free entry parses to today's value", () => {
  const asserted = proposal();
  const absent = {
    status: "declared-absent",
    backend: "http",
    model: "proposer-1",
    proposedAt: "2026-01-01T00:00:00Z",
  };
  const parsed = CorpusCaseSchema.parse({
    id: "c",
    inputs: [{ file: "input.txt", kind: "transcript" }],
    expected: {
      "a.b": pendingEntry(asserted),
      "a.c": confirmedEntry(asserted, { status: "asserted", value: "gas" }),
      "a.d": confirmedEntry(absent, { status: "declared-absent" }),
      // The pre-proposal shape: unchanged, unadorned.
      "a.e": { status: "asserted", value: "hand-written" },
    },
  });
  expect(parsed.expected["a.b"]).toMatchObject({ review: "pending" });
  expect(parsed.expected["a.c"]).toMatchObject({ review: "confirmed" });
  expect(parsed.expected["a.e"]).toEqual({ status: "asserted", value: "hand-written" });
});

test("a review without a proposal, and a proposal without a review, are refused naming the leaf", () => {
  const base = {
    id: "c",
    inputs: [{ file: "input.txt", kind: "transcript" }],
  };
  const reviewOnly = CorpusCaseSchema.safeParse({
    ...base,
    expected: { "home.address": { status: "asserted", value: "x", review: "pending" } },
  });
  expect(reviewOnly.success).toBe(false);
  if (!reviewOnly.success) {
    expect(describeIssues(reviewOnly.error.issues)).toContain('the expected entry "home.address"');
    expect(reviewOnly.error.issues.some((issue) => issue.path.includes("review"))).toBe(true);
  }
  const proposalOnly = CorpusCaseSchema.safeParse({
    ...base,
    expected: { "home.address": { status: "asserted", value: "x", proposal: proposal() } },
  });
  expect(proposalOnly.success).toBe(false);
  if (!proposalOnly.success) {
    expect(describeIssues(proposalOnly.error.issues)).toContain(
      'the expected entry "home.address"',
    );
    expect(proposalOnly.error.issues.some((issue) => issue.path.includes("proposal"))).toBe(true);
  }
});

test("the loader refuses evidence naming an input the case does not declare", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "morning-visit", "case.json"), (document) => {
      const expected = document["expected"] as Record<string, Record<string, unknown>>;
      expected["home.address"] = pendingEntry(
        proposal({ evidence: { quote: "14 Maple Street", input: "undeclared.txt" } }),
      );
    });
  });
  expect(refusal(dir)).toContain("undeclared.txt");
  expect(refusal(dir)).toContain("home.address");
});

test("the loader refuses a collection leaf whose evidence is not ordinal-keyed", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "morning-visit", "case.json"), (document) => {
      const expected = document["expected"] as Record<string, Record<string, unknown>>;
      expected["upgrades.measure"] = pendingEntry(
        proposal({
          value: "attic insulation top-up",
          evidence: { quote: "attic insulation top-up", input: "input.txt" },
        }),
      );
    });
  });
  expect(refusal(dir)).toContain("upgrades.measure");
  expect(refusal(dir)).toContain("ordinal");
});

test("the loader refuses a scalar leaf whose evidence is ordinal-keyed", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "morning-visit", "case.json"), (document) => {
      const expected = document["expected"] as Record<string, Record<string, unknown>>;
      expected["home.address"] = pendingEntry(
        proposal({
          evidence: { "0": { quote: "14 Maple Street", input: "input.txt" } },
        }),
      );
    });
  });
  expect(refusal(dir)).toContain("home.address");
  expect(refusal(dir)).toContain("ordinal");
});

/** A one-entry case, as the classification suites build it. */
const entryCases = (
  entry: Record<string, unknown>,
): { expected: Record<string, ExpectationEntry> } =>
  CorpusCaseSchema.parse({
    id: "c",
    inputs: [{ file: "input.txt", kind: "transcript" }],
    expected: { "a.b": entry },
  });

/** Resolve the single `a.b` entry a case was built with — always explicit. */
const resolveExplicit = (entry: Record<string, unknown>) => {
  const resolved = resolveExpectation(entryCases(entry), "a.b");
  if (resolved.origin !== "explicit") throw new Error("the explicit entry resolved unexplicit");
  if (resolved.status === "unmentioned") throw new Error("the explicit entry resolved unmentioned");
  return resolved;
};

/** The single `a.b` entry's review class. */
const classify = (entry: Record<string, unknown>): ExpectationReviewClass =>
  resolveExplicit(entry).reviewClass;

test("an entry with no proposal is hand-written", () => {
  expect(classify({ status: "asserted", value: "hand-written" })).toBe("hand-written");
  expect(classify({ status: "declared-absent" })).toBe("hand-written");
});

test("a pending entry stays pending, and carries its proposer", () => {
  const resolved = resolveExplicit(pendingEntry(proposal()));
  expect(resolved.reviewClass).toBe("pending");
  expect(resolved).toMatchObject({ proposerBackend: "http", proposerModel: "proposer-1" });
});

test("a confirmed entry the reviewer did not touch is accepted-unchanged", () => {
  expect(classify(confirmedEntry(proposal(), { status: "asserted", value: "gas" }))).toBe(
    "accepted-unchanged",
  );
  expect(
    classify(
      confirmedEntry(
        {
          status: "declared-absent",
          backend: "http",
          model: "proposer-1",
          proposedAt: "2026-01-01T00:00:00Z",
        },
        { status: "declared-absent" },
      ),
    ),
  ).toBe("accepted-unchanged");
});

test("a value edit that is the same answer under the bridge is still accepted-unchanged", () => {
  expect(classify(confirmedEntry(proposal(), { status: "asserted", value: " Gas. " }))).toBe(
    "accepted-unchanged",
  );
});

test("a value change, an added alternative and a status change each classify as corrected", () => {
  // A different value.
  expect(classify(confirmedEntry(proposal(), { status: "asserted", value: "electric" }))).toBe(
    "corrected",
  );
  // Any added alternative — a proposal never carries one, so an alternative is an addition.
  expect(
    classify(
      confirmedEntry(proposal(), {
        status: "asserted",
        value: "gas",
        alternatives: ["propane"],
      }),
    ),
  ).toBe("corrected");
  // A changed status, in both directions.
  expect(
    classify(
      confirmedEntry(
        {
          status: "declared-absent",
          backend: "http",
          model: "proposer-1",
          proposedAt: "2026-01-01T00:00:00Z",
        },
        { status: "asserted", value: "gas" },
      ),
    ),
  ).toBe("corrected");
  expect(classify(confirmedEntry(proposal(), { status: "declared-absent" }))).toBe("corrected");
});

test("the classification is visible through the public barrel's proposal schema", () => {
  const parsed = ExpectationProposalSchema.parse(proposal());
  expect(parsed.status).toBe("asserted");
  expect(ProposalEvidenceSchema.parse({ quote: "q", input: "i" })).toEqual({
    quote: "q",
    input: "i",
  });
});
