/**
 * @file Two-phase extract-then-classify spike for the on-device model.
 *
 * Hypothesis tested: the whitespace loop in the per-group object constraint is a
 * property of the grammar, not the model. A JSON object permits arbitrary whitespace
 * between tokens, so an unbounded run of newlines is a legal continuation. A narrower
 * constraint — a bare enum, a single number, or a single string — has no room for
 * free whitespace, so the loop becomes structurally impossible.
 *
 * Phase 1: one call per group. The constraint is a flat object mapping each leaf in
 * that group to a nullable string: the verbatim quote from the transcript discussing
 * that leaf, or null if the transcript does not mention it. No enums, no nesting, no
 * confidence.
 *
 * Phase 2: one call per non-null span. The constraint is the narrowest thing the leaf
 * allows: the `value` schema from the provenance envelope, used as a bare root. If the
 * browser rejects a bare non-object root, we fall back to wrapping it in a single-key
 * object and log the weakness.
 *
 * The output shape is the same nested enveloped result the existing per-group strategy
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
  chatRequest,
  classifyLeaf,
  extractGroups,
  isDegeneration,
  isSchemaNode,
} from "./shared.js";

export interface TwoPhaseStats {
  phase1Attempts: number;
  phase1Degenerations: number;
  phase2Attempts: number;
  phase2Degenerations: number;
  phase2BareRejected: number;
  phase2WrappedAttempts: number;
  phase2WrappedDegenerations: number;
}

export function newStats(): TwoPhaseStats {
  return {
    phase1Attempts: 0,
    phase1Degenerations: 0,
    phase2Attempts: 0,
    phase2Degenerations: 0,
    phase2BareRejected: 0,
    phase2WrappedAttempts: 0,
    phase2WrappedDegenerations: 0,
  };
}

export function mergeStats(into: TwoPhaseStats, from: TwoPhaseStats): TwoPhaseStats {
  into.phase1Attempts += from.phase1Attempts;
  into.phase1Degenerations += from.phase1Degenerations;
  into.phase2Attempts += from.phase2Attempts;
  into.phase2Degenerations += from.phase2Degenerations;
  into.phase2BareRejected += from.phase2BareRejected;
  into.phase2WrappedAttempts += from.phase2WrappedAttempts;
  into.phase2WrappedDegenerations += from.phase2WrappedDegenerations;
  return into;
}

export function formatStats(stats: TwoPhaseStats): string {
  const rate = (count: number, total: number): string =>
    total === 0 ? "0.0" : ((count / total) * 100).toFixed(1);
  const totalCalls = stats.phase1Attempts + stats.phase2Attempts + stats.phase2WrappedAttempts;
  return (
    `two-phase stats: ${totalCalls} total calls, ` +
    `phase1 ${stats.phase1Degenerations}/${stats.phase1Attempts} loops (${rate(
      stats.phase1Degenerations,
      stats.phase1Attempts,
    )}%), ` +
    `phase2 ${stats.phase2Degenerations}/${stats.phase2Attempts} loops (${rate(
      stats.phase2Degenerations,
      stats.phase2Attempts,
    )}%), ` +
    `phase2 bare rejected ${stats.phase2BareRejected}×, ` +
    `wrapped ${stats.phase2WrappedAttempts} attempts ` +
    `(${stats.phase2WrappedDegenerations} loops)`
  );
}

export async function extractTwoPhase(
  transcript: string,
  chat: OnDeviceChat,
  log: (line: string) => void,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<{ fields: SnuggExtraction; stats: TwoPhaseStats }> {
  const schema = z.toJSONSchema(snuggExtractionSchema, { target: "draft-2020-12" }) as JsonSchema;
  const groups = extractGroups(schema);
  if (groups.length === 0) {
    throw new Error("Two-phase extractor: no groups found in extraction schema");
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
    let spans: Record<string, string | null>;
    try {
      spans = await extractSpans(group, transcript, chat, maxRetries, stats);
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

async function extractSpans(
  group: Group,
  transcript: string,
  chat: OnDeviceChat,
  maxRetries: number,
  stats: TwoPhaseStats,
): Promise<Record<string, string | null>> {
  const schema = buildPhase1Schema(group);
  const request = chatRequest(MODEL, buildPhase1Messages(group, transcript), schema);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stats.phase1Attempts += 1;
    try {
      const completion = await chat.complete(request);
      return parsePhase1Response(completion.content, group);
    } catch (error) {
      lastError = error;
      if (isDegeneration(error)) {
        stats.phase1Degenerations += 1;
      }
    }
  }
  throw lastError;
}

function buildPhase1Schema(group: Group): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const leaf of group.leaves) {
    properties[leaf.key] = { anyOf: [{ type: "string" }, { type: "null" }] };
  }
  return {
    type: "object",
    properties,
    required: group.leaves.map((leaf) => leaf.key),
    additionalProperties: false,
  };
}

function buildPhase1Messages(group: Group, transcript: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `Extract verbatim quotes from the auditor's spoken field notes for the ${group.key} group.\n\n` +
        `For each field listed below, return the exact contiguous quote from the transcript that discusses ` +
        `that field, or null if the transcript does not mention it. Inventing a quote is worse than returning null.\n\n` +
        `Return a single JSON object with exactly these keys: ${group.leaves.map((leaf) => leaf.key).join(", ")}. ` +
        `Each value is either a string (the quote) or null. No extra keys, no commentary, no markdown fences.`,
    },
    { role: "user", content: transcript },
  ];
}

function parsePhase1Response(content: string, group: Group): Record<string, string | null> {
  const raw = JSON.parse(content);
  if (!isSchemaNode(raw)) {
    throw new Error("Phase 1 response is not a JSON object");
  }
  const result: Record<string, string | null> = {};
  for (const leaf of group.leaves) {
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
