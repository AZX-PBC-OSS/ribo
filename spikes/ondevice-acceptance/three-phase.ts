/**
 * @file Three-phase presence-first extract-then-classify spike for the on-device model.
 *
 * Hypothesis tested: asking a boolean presence question is easier for a small model
 * than asking for a nullable verbatim quote. A boolean has no text to invent, so the
 * model may decline cleanly (false) where it currently fabricates a span.
 *
 * Phase 0: one call per group. The constraint is a flat object mapping each leaf in
 * that group to a boolean: did the transcript explicitly discuss this field?
 *
 * Phase 1: one call per group whose phase 0 answered true to at least one leaf. The
 * constraint is a flat object mapping only the phase-0-true leaves to a nullable
 * string (the verbatim quote). Groups that phase 0 marked entirely false are skipped.
 *
 * Phase 2: unchanged from the two-phase strategy: one call per non-null span for the
 * leaf value, with a bare-root fallback to a single-key object.
 *
 * The output shape is the same nested enveloped result the per-group strategy
 * produces, so `score.mjs` reads it unchanged.
 */

import { snuggExtractionSchema } from "@azx/ribo-adapter-snuggpro";
import type { SnuggExtraction } from "@azx/ribo-adapter-snuggpro";
import type { OnDeviceChat } from "@azx/ribo-extractor-ondevice";
import type { ChatMessage } from "@azx/ribo-extractor-openai";
import { z } from "zod";

import {
  DEFAULT_MAX_RETRIES,
  MODEL,
  type Group,
  type JsonSchema,
  type Leaf,
  chatRequest,
  classifyLeaf,
  extractGroups,
  isDegeneration,
  isSchemaNode,
} from "./shared.js";

export interface ThreePhaseStats {
  phase0Attempts: number;
  phase0Degenerations: number;
  phase1Attempts: number;
  phase1Degenerations: number;
  phase2Attempts: number;
  phase2Degenerations: number;
  phase2BareRejected: number;
  phase2WrappedAttempts: number;
  phase2WrappedDegenerations: number;
  presenceAsked: number;
  presenceTrue: number;
  groupsSkipped: number;
}

export function newStats(): ThreePhaseStats {
  return {
    phase0Attempts: 0,
    phase0Degenerations: 0,
    phase1Attempts: 0,
    phase1Degenerations: 0,
    phase2Attempts: 0,
    phase2Degenerations: 0,
    phase2BareRejected: 0,
    phase2WrappedAttempts: 0,
    phase2WrappedDegenerations: 0,
    presenceAsked: 0,
    presenceTrue: 0,
    groupsSkipped: 0,
  };
}

export function mergeStats(into: ThreePhaseStats, from: ThreePhaseStats): ThreePhaseStats {
  into.phase0Attempts += from.phase0Attempts;
  into.phase0Degenerations += from.phase0Degenerations;
  into.phase1Attempts += from.phase1Attempts;
  into.phase1Degenerations += from.phase1Degenerations;
  into.phase2Attempts += from.phase2Attempts;
  into.phase2Degenerations += from.phase2Degenerations;
  into.phase2BareRejected += from.phase2BareRejected;
  into.phase2WrappedAttempts += from.phase2WrappedAttempts;
  into.phase2WrappedDegenerations += from.phase2WrappedDegenerations;
  into.presenceAsked += from.presenceAsked;
  into.presenceTrue += from.presenceTrue;
  into.groupsSkipped += from.groupsSkipped;
  return into;
}

export function formatStats(stats: ThreePhaseStats): string {
  const rate = (count: number, total: number): string =>
    total === 0 ? "0.0" : ((count / total) * 100).toFixed(1);
  const totalCalls =
    stats.phase0Attempts +
    stats.phase1Attempts +
    stats.phase2Attempts +
    stats.phase2WrappedAttempts;
  const presenceRate = rate(stats.presenceTrue, stats.presenceAsked);
  return (
    `three-phase stats: ${totalCalls} total calls, ` +
    `phase0 ${stats.phase0Degenerations}/${stats.phase0Attempts} loops (${rate(
      stats.phase0Degenerations,
      stats.phase0Attempts,
    )}%), ` +
    `phase1 ${stats.phase1Degenerations}/${stats.phase1Attempts} loops (${rate(
      stats.phase1Degenerations,
      stats.phase1Attempts,
    )}%), ` +
    `phase2 ${stats.phase2Degenerations}/${stats.phase2Attempts} loops (${rate(
      stats.phase2Degenerations,
      stats.phase2Attempts,
    )}%), ` +
    `presence-true rate ${stats.presenceTrue}/${stats.presenceAsked} (${presenceRate}%)` +
    ` — if this rate is near 100%, the gate failed and this strategy added a phase for no benefit, ` +
    `groups skipped ${stats.groupsSkipped}, ` +
    `phase2 bare rejected ${stats.phase2BareRejected}×, ` +
    `wrapped ${stats.phase2WrappedAttempts} attempts ` +
    `(${stats.phase2WrappedDegenerations} loops)`
  );
}

export async function extractThreePhase(
  transcript: string,
  chat: OnDeviceChat,
  log: (line: string) => void,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<{ fields: SnuggExtraction; stats: ThreePhaseStats }> {
  const schema = z.toJSONSchema(snuggExtractionSchema, { target: "draft-2020-12" }) as JsonSchema;
  const groups = extractGroups(schema);
  if (groups.length === 0) {
    throw new Error("Three-phase extractor: no groups found in extraction schema");
  }

  const result: Record<
    string,
    Record<string, { value: unknown; confidence: number; sourceSpan: string | null }>
  > = {};
  const stats = newStats();

  for (const group of groups) {
    const groupResult: Record<
      string,
      { value: unknown; confidence: number; sourceSpan: string | null }
    > = {};
    result[group.key] = groupResult;
    let presence: Record<string, boolean>;
    try {
      presence = await extractPresence(group, transcript, chat, maxRetries, stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `  group ${group.key}: phase 0 failed — ${message.slice(0, 120)}; emitting all-null group`,
      );
      for (const leaf of group.leaves) {
        groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
      }
      continue;
    }

    const activeLeaves = group.leaves.filter((leaf) => presence[leaf.key] === true);
    stats.presenceAsked += group.leaves.length;
    stats.presenceTrue += activeLeaves.length;

    if (activeLeaves.length === 0) {
      stats.groupsSkipped += 1;
      for (const leaf of group.leaves) {
        groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
      }
      log(`  group ${group.key}: phase 0 said false to every leaf; skipped`);
      continue;
    }

    let spans: Record<string, string | null>;
    try {
      spans = await extractSpans(group, activeLeaves, transcript, chat, maxRetries, stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `  group ${group.key}: phase 1 failed — ${message.slice(0, 120)}; emitting all-null group`,
      );
      for (const leaf of group.leaves) {
        groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
      }
      continue;
    }

    for (const leaf of group.leaves) {
      const span = spans[leaf.key] ?? null;
      if (span === null) {
        groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
        continue;
      }
      const value = await classifyLeaf(leaf, span, chat, log, maxRetries, stats);
      groupResult[leaf.key] = {
        value,
        sourceSpan: span,
        // Confidence is a placeholder: this strategy has no calibrated confidence.
        // The repo already records that confidence does not discriminate hallucinations.
        // 1 = leaf got a value; 0 = no value (no span or phase 2 failed).
        confidence: value !== null ? 1 : 0,
      };
    }
  }

  return { fields: result as unknown as SnuggExtraction, stats };
}

async function extractPresence(
  group: Group,
  transcript: string,
  chat: OnDeviceChat,
  maxRetries: number,
  stats: ThreePhaseStats,
): Promise<Record<string, boolean>> {
  const schema = buildPhase0Schema(group);
  const request = chatRequest(
    MODEL,
    buildPhase0Messages(group, transcript),
    schema,
    "three-phase-presence",
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stats.phase0Attempts += 1;
    try {
      const completion = await chat.complete(request);
      return parsePhase0Response(completion.content, group);
    } catch (error) {
      lastError = error;
      if (isDegeneration(error)) {
        stats.phase0Degenerations += 1;
      }
    }
  }
  throw lastError;
}

function buildPhase0Schema(group: Group): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const leaf of group.leaves) {
    properties[leaf.key] = { type: "boolean" };
  }
  return {
    type: "object",
    properties,
    required: group.leaves.map((leaf) => leaf.key),
    additionalProperties: false,
  };
}

function buildPhase0Messages(group: Group, transcript: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `For the ${group.key} group, determine which of the following fields are discussed in the auditor's spoken field notes.\n\n` +
        `Return a single JSON object with exactly these keys: ${group.leaves.map((leaf) => leaf.key).join(", ")}. ` +
        `Each value must be a boolean: true if the transcript explicitly discusses the field, ` +
        `false if it is not mentioned, only implied, or unrelated. ` +
        `A field merely implied is false. No extra keys, no commentary, no markdown fences.`,
    },
    { role: "user", content: transcript },
  ];
}

function parsePhase0Response(content: string, group: Group): Record<string, boolean> {
  const raw = JSON.parse(content);
  if (!isSchemaNode(raw)) {
    throw new Error("Phase 0 response is not a JSON object");
  }
  const result: Record<string, boolean> = {};
  for (const leaf of group.leaves) {
    const value = raw[leaf.key];
    if (typeof value === "boolean") {
      result[leaf.key] = value;
    } else {
      throw new Error(`Phase 0 response for ${leaf.path} is not a boolean`);
    }
  }
  return result;
}

async function extractSpans(
  group: Group,
  activeLeaves: readonly Leaf[],
  transcript: string,
  chat: OnDeviceChat,
  maxRetries: number,
  stats: ThreePhaseStats,
): Promise<Record<string, string | null>> {
  const schema = buildPhase1Schema(activeLeaves);
  const request = chatRequest(
    MODEL,
    buildPhase1Messages(group, activeLeaves, transcript),
    schema,
    "three-phase-spans",
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stats.phase1Attempts += 1;
    try {
      const completion = await chat.complete(request);
      return parsePhase1Response(completion.content, activeLeaves);
    } catch (error) {
      lastError = error;
      if (isDegeneration(error)) {
        stats.phase1Degenerations += 1;
      }
    }
  }
  throw lastError;
}

function buildPhase1Schema(leaves: readonly Leaf[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const leaf of leaves) {
    properties[leaf.key] = { anyOf: [{ type: "string" }, { type: "null" }] };
  }
  return {
    type: "object",
    properties,
    required: leaves.map((leaf) => leaf.key),
    additionalProperties: false,
  };
}

function buildPhase1Messages(
  group: Group,
  leaves: readonly Leaf[],
  transcript: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `Extract verbatim quotes from the auditor's spoken field notes for the ${group.key} group.\n\n` +
        `For each field listed below, return the exact contiguous quote from the transcript that discusses ` +
        `that field, or null if the transcript does not mention it. Inventing a quote is worse than returning null.\n\n` +
        `Return a single JSON object with exactly these keys: ${leaves.map((leaf) => leaf.key).join(", ")}. ` +
        `Each value is either a string (the quote) or null. No extra keys, no commentary, no markdown fences.`,
    },
    { role: "user", content: transcript },
  ];
}

function parsePhase1Response(
  content: string,
  leaves: readonly Leaf[],
): Record<string, string | null> {
  const raw = JSON.parse(content);
  if (!isSchemaNode(raw)) {
    throw new Error("Phase 1 response is not a JSON object");
  }
  const result: Record<string, string | null> = {};
  for (const leaf of leaves) {
    const value = raw[leaf.key];
    if (value === null || value === undefined) {
      result[leaf.key] = null;
    } else if (typeof value === "string") {
      result[leaf.key] = value;
    } else {
      throw new Error(`Phase 1 response for ${leaf.path} is not a string or null`);
    }
  }
  return result;
}
