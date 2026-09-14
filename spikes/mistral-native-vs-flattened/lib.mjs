/**
 * Shared helpers for the mistral-native-vs-flattened spike.
 *
 * Credentials are read from /Users/ekongiy/projects/azx/ribo/.env.local by
 * absolute path and never printed. No document text, OCR markdown, or extracted
 * names/addresses is written outside the gitignored results/ directory.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const RESULTS_DIR = join(HERE, "results");
export const CORPUS_DIR = "/Users/ekongiy/Downloads/Turnkey Tech Review Doc Examples";

const CORE_DIST = join(REPO_ROOT, "packages", "ribo-core", "dist", "index.js");
const EXT_DIST = join(REPO_ROOT, "packages", "ribo-extractor-openai", "dist", "index.js");

export async function loadRibo() {
  const core = await import(CORE_DIST);
  const ext = await import(EXT_DIST);
  const requireFromCore = createRequire(join(REPO_ROOT, "packages", "ribo-core", "package.json"));
  const { z } = requireFromCore("zod");
  return { core, ext, z };
}

export function loadCredentials() {
  const envText = readFileSync("/Users/ekongiy/projects/azx/ribo/.env.local", "utf8");
  const get = (name) => envText.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
  const apiKey = get("AZURE_AI_FOUNDRY_API_KEY");
  const anthropicBaseUrl = get("AZURE_AI_FOUNDRY_ANTHROPIC_BASE_URL");
  if (!apiKey || !anthropicBaseUrl) {
    throw new Error("missing AZURE_AI_FOUNDRY_API_KEY or AZURE_AI_FOUNDRY_ANTHROPIC_BASE_URL");
  }
  // The Mistral OCR endpoint lives on the same Azure AI Foundry resource.
  const resourceOrigin = new URL(anthropicBaseUrl).origin;
  return { apiKey, anthropicBaseUrl, resourceOrigin };
}

/**
 * One Mistral OCR call. `annotation` is optional: when given, it must be
 * { name, schema, prompt } and is passed as document_annotation_format with
 * strict: true plus document_annotation_prompt.
 *
 * Returns { markdown, annotation, latencyMs, usage }. `markdown` is the
 * pages[].markdown joined with a page-break marker line per page, so that
 * every span the model saw is checkable against the same string.
 */
export async function mistralOcr({ apiKey, resourceOrigin, pdfPath, annotation }) {
  const url = `${resourceOrigin}/providers/mistral/azure/ocr?api-version=2024-05-01-preview`;
  const b64 = readFileSync(pdfPath).toString("base64");

  const body = {
    model: "mistral-document-ai-2512",
    document: { type: "document_url", document_url: `data:application/pdf;base64,${b64}` },
    table_format: "markdown",
    ...(annotation
      ? {
          document_annotation_format: {
            type: "json_schema",
            json_schema: { name: annotation.name, strict: true, schema: annotation.schema },
          },
          document_annotation_prompt: annotation.prompt,
        }
      : {}),
  };

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body),
  });
  const latencyMs = Math.round(performance.now() - started);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `mistral-ocr: ${response.status} ${response.statusText}: ${detail.slice(0, 800)}`,
    );
  }

  const data = await response.json();
  const pages = data.pages ?? [];
  // Defensive only, and currently inert: measured 2026-09-11, both documents in this spike
  // return their tables already inline in `markdown` with `pages[].tables` empty, so this loop
  // never runs. Kept in case some document does link tables out — see FINDINGS.md, which
  // corrects an earlier claim that this was observed.
  const markdown = pages
    .map((p, i) => {
      let md = p.markdown ?? "";
      for (const t of p.tables ?? []) {
        if (t?.id && typeof t?.content === "string") {
          md = md.split(`[${t.id}](${t.id})`).join(t.content);
        }
      }
      return `<!-- page ${i + 1} -->\n${md}`;
    })
    .join("\n\n");

  let annotation_ = null;
  if (data.document_annotation != null) {
    annotation_ =
      typeof data.document_annotation === "string"
        ? JSON.parse(data.document_annotation)
        : data.document_annotation;
  }

  return {
    markdown,
    annotation: annotation_,
    latencyMs,
    usage: data.usage_info ?? null,
    raw: data,
  };
}

/**
 * Anthropic Messages API behind Ribo's ChatClient seam (tool_use for
 * structured output) — same shape as the prompt-vs-granularity spike.
 */
export function anthropicChat({ apiKey, baseUrl }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  return {
    async complete(request, options) {
      const systemMsg = request.messages.find((m) => m.role === "system");
      const chatMessages = request.messages.filter((m) => m.role !== "system");

      const body = {
        model: request.model,
        max_tokens: request.maxTokens ?? 16000,
        messages: chatMessages,
        ...(systemMsg ? { system: systemMsg.content } : {}),
        tools: [
          {
            name: request.response_format.json_schema.name,
            description: "Extract structured data from the document.",
            input_schema: request.response_format.json_schema.schema,
          },
        ],
        tool_choice: { type: "tool", name: request.response_format.json_schema.name },
      };

      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        });
      } catch (cause) {
        throw new Error(
          `anthropicChat: fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`anthropicChat: ${response.status}: ${detail.slice(0, 500)}`);
      }

      const data = await response.json();
      const toolUse = data.content?.find((c) => c.type === "tool_use");
      const textBlock = data.content?.find((c) => c.type === "text");
      const content = toolUse ? JSON.stringify(toolUse.input) : textBlock ? textBlock.text : "{}";

      const finishMap = {
        end_turn: "stop",
        tool_use: "stop",
        max_tokens: "length",
        stop_sequence: "stop",
      };
      return {
        content,
        finishReason: finishMap[data.stop_reason] ?? "stop",
        usage: data.usage
          ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
          : undefined,
      };
    },
  };
}
