/**
 * Gap-fill and ungrounded-retry passes for arms C and D.
 *
 * Neither `gapFillExtractor` nor `findAbstainedLeaves` exist in the published
 * `@azx/ribo-extractor-openai` package yet (the task references a file that has
 * not been written), so both are implemented here in the spike.
 */

import { isSpanGrounded } from "../../packages/ribo-core/dist/index.js";
import { findAbstainedLeaves, findUngroundedLeaves } from "./score.mjs";

/**
 * Re-ask the model for leaves that abstained (value is null).
 *
 * Builds a mini-schema containing only the abstained leaf paths, sends it
 * with the document text, and merges any recovered values back into the
 * original extraction.
 */
export async function gapFill(
  extraction,
  leaves,
  transcript,
  chatClient,
  model,
  buildSchemaForPaths,
) {
  const abstained = findAbstainedLeaves(leaves);
  if (abstained.length === 0) {
    return {
      merged: extraction,
      recovered: 0,
      grounded: 0,
      stillNull: 0,
      calls: 0,
      tokens: { in: 0, out: 0 },
    };
  }

  const paths = abstained.map((l) => l.path);
  const { schema } = buildSchemaForPaths(paths);

  const systemPrompt =
    "You are extracting specific fields from a Manual J document. " +
    "For each field, provide value (verbatim from document or null), confidence (0-1), " +
    "and sourceSpan (exact verbatim quote or null). " +
    "Only fill in fields you can find in the document. If a field is truly not stated, keep it null.\n\n" +
    "Respond with ONLY valid JSON conforming to this schema:\n\n" +
    JSON.stringify(schema, null, 2);

  const userPrompt =
    "The following fields were previously left empty. Please check the document again and fill in any you can find.\n\n" +
    `Fields to check: ${paths.join(", ")}\n\n` +
    `<document>\n${transcript}\n</document>`;

  const t0 = Date.now();
  const completion = await chatClient.complete({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "gap-fill", schema, strict: true },
    },
    maxTokens: 8000,
  });
  const elapsed = (Date.now() - t0) / 1000;

  let recovered = 0;
  let grounded = 0;
  let stillNull = 0;

  let fillData;
  try {
    fillData = JSON.parse(completion.content);
  } catch {
    return {
      merged: extraction,
      recovered: 0,
      grounded: 0,
      stillNull: abstained.length,
      calls: 1,
      tokens: {
        in: completion.usage?.promptTokens || 0,
        out: completion.usage?.completionTokens || 0,
      },
      elapsed,
      error: "failed to parse gap-fill response",
    };
  }

  // Merge recovered values back
  const merged = structuredClone(extraction);
  for (const leaf of abstained) {
    const filled = getAtPath(fillData, leaf.path);
    if (filled && filled.value !== null && filled.value !== undefined && filled.value !== "") {
      setAtPath(merged, leaf.path, filled);
      recovered++;
      if (filled.sourceSpan && isSpanGrounded(filled.sourceSpan, transcript)) {
        grounded++;
      }
    } else {
      stillNull++;
    }
  }

  return {
    merged,
    recovered,
    grounded,
    stillNull,
    calls: 1,
    tokens: {
      in: completion.usage?.promptTokens || 0,
      out: completion.usage?.completionTokens || 0,
    },
    elapsed,
  };
}

/**
 * Re-ask the model for leaves whose span is ungrounded (fabricated).
 *
 * Tells the model: "you asserted X citing Y; Y does not appear in the document;
 * either quote the real text or return null."
 */
export async function ungroundedRetry(leaves, transcript, chatClient, model, buildSchemaForPaths) {
  const ungrounded = findUngroundedLeaves(leaves, transcript);
  if (ungrounded.length === 0) {
    return {
      converted: 0,
      grounded: 0,
      toNull: 0,
      stayedWrong: 0,
      calls: 0,
      tokens: { in: 0, out: 0 },
      elapsed: 0,
    };
  }

  const paths = ungrounded.map((l) => l.path);
  const { schema } = buildSchemaForPaths(paths);

  const items = ungrounded
    .map(
      (l) =>
        `Field "${l.path}": you previously asserted value="${l.value}" citing sourceSpan="${l.sourceSpan}". ` +
        `That span does not appear verbatim in the document. ` +
        `Either find the correct verbatim quote from the document, or set value to null and sourceSpan to null.`,
    )
    .join("\n\n");

  const systemPrompt =
    "You are correcting extraction errors. For each field, either:\n" +
    "1. Provide the correct verbatim sourceSpan from the document that justifies the value, or\n" +
    "2. Set both value and sourceSpan to null if the field is not actually stated.\n\n" +
    "Respond with ONLY valid JSON conforming to this schema:\n\n" +
    JSON.stringify(schema, null, 2);

  const userPrompt =
    `Corrections needed:\n\n${items}\n\n` + `<document>\n${transcript}\n</document>`;

  const t0 = Date.now();
  const completion = await chatClient.complete({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "ungrounded-retry", schema, strict: true },
    },
    maxTokens: 8000,
  });
  const elapsed = (Date.now() - t0) / 1000;

  let retryData;
  try {
    retryData = JSON.parse(completion.content);
  } catch {
    return {
      converted: 0,
      grounded: 0,
      toNull: 0,
      stayedWrong: ungrounded.length,
      calls: 1,
      tokens: {
        in: completion.usage?.promptTokens || 0,
        out: completion.usage?.completionTokens || 0,
      },
      elapsed,
      error: "failed to parse retry response",
    };
  }

  let grounded = 0;
  let toNull = 0;
  let stayedWrong = 0;

  for (const leaf of ungrounded) {
    const corrected = getAtPath(retryData, leaf.path);
    if (!corrected) {
      stayedWrong++;
      continue;
    }
    if (corrected.value === null || corrected.value === undefined || corrected.value === "") {
      toNull++;
    } else if (corrected.sourceSpan && isSpanGrounded(corrected.sourceSpan, transcript)) {
      grounded++;
    } else {
      stayedWrong++;
    }
  }

  return {
    retryData,
    converted: grounded + toNull,
    grounded,
    toNull,
    stayedWrong,
    calls: 1,
    tokens: {
      in: completion.usage?.promptTokens || 0,
      out: completion.usage?.completionTokens || 0,
    },
    elapsed,
    ungroundedPaths: paths,
  };
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

export function getAtPath(obj, path) {
  const parts = parsePath(path);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function setAtPath(obj, path, value) {
  const parts = parsePath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function parsePath(path) {
  // Handle paths like "mj_context.report.tool_vendor" and "mj_rooms.rooms[0].name"
  const parts = [];
  const segments = path.split(".");
  for (const seg of segments) {
    const bracketMatch = seg.match(/^([^[]+)((?:\[\d+\])*)$/);
    if (bracketMatch) {
      parts.push(bracketMatch[1]);
      const brackets = bracketMatch[2];
      if (brackets) {
        const indices = brackets.match(/\[(\d+)\]/g);
        if (indices) {
          for (const idx of indices) {
            parts.push(parseInt(idx.replace(/[[\]]/g, ""), 10));
          }
        }
      }
    } else {
      parts.push(seg);
    }
  }
  return parts;
}
