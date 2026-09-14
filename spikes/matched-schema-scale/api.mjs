/**
 * API clients for the spike:
 *
 *  - `mistralOcr()`        — OCR-only call (pages[].markdown, no annotation)
 *  - `mistralNative()`     — OCR + structured extraction in one call
 *  - `anthropicChat()`     — ChatClient impl for Azure AI Foundry's Anthropic endpoint
 *
 * All credentials are read from `.env.local` by absolute path. No key is ever
 * printed or written to a committed file.
 */

import { readFileSync } from "node:fs";

const ENV_PATH = "/Users/ekongiy/projects/azx/ribo/.env.local";

function loadEnv() {
  const text = readFileSync(ENV_PATH, "utf-8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const ENV = loadEnv();
const API_KEY = ENV.AZURE_AI_FOUNDRY_API_KEY;
const ANTHROPIC_BASE = ENV.AZURE_AI_FOUNDRY_ANTHROPIC_BASE_URL;

function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

const MISTRAL_ORIGIN = originOf(ANTHROPIC_BASE);
const MISTRAL_URL = `${MISTRAL_ORIGIN}/providers/mistral/azure/ocr?api-version=2024-05-01-preview`;

// ---------------------------------------------------------------------------
// Mistral OCR + native extraction
// ---------------------------------------------------------------------------

export async function mistralOcr(pdfPath) {
  const pdfBytes = readFileSync(pdfPath);
  const b64 = pdfBytes.toString("base64");
  const body = {
    model: "mistral-document-ai-2512",
    document: {
      type: "document_url",
      document_url: `data:application/pdf;base64,${b64}`,
    },
  };
  return fetchWithRetry(MISTRAL_URL, body);
}

export async function mistralNative(pdfPath, envelopedJsonSchema, prompt) {
  const pdfBytes = readFileSync(pdfPath);
  const b64 = pdfBytes.toString("base64");
  const body = {
    model: "mistral-document-ai-2512",
    document: {
      type: "document_url",
      document_url: `data:application/pdf;base64,${b64}`,
    },
    document_annotation_format: {
      type: "json_schema",
      json_schema: {
        name: "manual-j-extraction",
        strict: true,
        schema: envelopedJsonSchema,
      },
    },
    document_annotation_prompt: prompt,
  };
  return fetchWithRetry(MISTRAL_URL, body);
}

async function fetchWithRetry(url, body, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "api-key": API_KEY,
        },
        body: JSON.stringify(body),
      });
      const elapsed = (Date.now() - t0) / 1000;

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`Mistral API ${res.status}: ${detail.slice(0, 500)}`);
        err.status = res.status;
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw err;
      }

      const json = await res.json();
      return { json, elapsed };
    } catch (err) {
      if (err.status) throw err;
      lastErr = err;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function extractMarkdown(mistralResponse) {
  const pages = mistralResponse.pages || [];
  return pages.map((p) => p.markdown || "").join("\n\n");
}

// ---------------------------------------------------------------------------
// Anthropic ChatClient for Azure AI Foundry
// ---------------------------------------------------------------------------

/**
 * Build a ChatClient that talks to Azure AI Foundry's Anthropic Messages API.
 *
 * The Ribo extractor's ChatClient interface is OpenAI-compatible, but the
 * Anthropic endpoint uses the Messages API format. This adapter translates:
 *   - ChatRequest.messages → Anthropic messages (system extracted)
 *   - response_format.json_schema.schema → included in a "return only JSON" instruction
 *   - Anthropic response → ChatCompletion { content, finishReason, usage }
 */
export function anthropicChat({ model }) {
  const url = `${ANTHROPIC_BASE.replace(/\/+$/, "")}/v1/messages`;

  return {
    async complete(request, options) {
      const messages = request.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

      // Extract system message
      let system = "";
      const chatMessages = [];
      for (const m of messages) {
        if (m.role === "system") {
          system += (system ? "\n\n" : "") + m.content;
        } else {
          chatMessages.push(m);
        }
      }

      // Add JSON schema instruction if response_format is present
      if (request.response_format?.json_schema?.schema) {
        system +=
          (system ? "\n\n" : "") +
          "CRITICAL: You must respond with ONLY valid JSON conforming to this JSON Schema. " +
          "No markdown, no explanation, no code fences — only the JSON object.\n\n" +
          "Every leaf field must be an object with exactly three keys: " +
          '"value" (the verbatim string from the document, or null), ' +
          '"confidence" (a number 0.0-1.0), and ' +
          '"sourceSpan" (the exact verbatim quote from the document text, or null). ' +
          "Never return a bare string for a leaf field — always wrap it in " +
          '{"value": "...", "confidence": 0.9, "sourceSpan": "..."}.\n\n' +
          "JSON Schema:\n" +
          JSON.stringify(request.response_format.json_schema.schema, null, 2);
      }

      const wireBody = {
        model,
        system,
        messages: chatMessages,
        max_tokens: request.maxTokens || 16000,
        temperature: 0,
      };

      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${API_KEY}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(wireBody),
          signal: options?.signal,
        });
      } catch (cause) {
        throw new Error(`anthropicChat: fetch failed: ${cause.message}`, { cause });
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `anthropicChat: ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`,
        );
      }

      const body = await response.json();

      let content = body.content?.find((c) => c.type === "text")?.text;
      if (typeof content !== "string") {
        throw new Error("anthropicChat: no text content in response");
      }
      // Strip markdown code fences — Claude often wraps JSON in ```json ... ```
      content = content
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();

      const stopReasonMap = {
        end_turn: "stop",
        max_tokens: "length",
        stop_sequence: "stop",
      };
      const finishReason = stopReasonMap[body.stop_reason] || "stop";

      const usage = body.usage
        ? {
            promptTokens: body.usage.input_tokens || 0,
            completionTokens: body.usage.output_tokens || 0,
          }
        : undefined;

      return { content, finishReason, usage };
    },
  };
}
