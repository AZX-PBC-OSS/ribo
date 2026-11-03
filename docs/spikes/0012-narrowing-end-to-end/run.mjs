// Spike 0012: presence narrowing end to end — the run ADR 0027 and spike 0011 both say must happen
// before narrowing ships. Three arms over the same chat model, per transcript:
//
//   baseline  perGroupExtractor, split as the field app splits (32,768 chars, no union cap: 22 calls)
//   md-1      presenceNarrowedExtractor, Microsoft-Decision-1 deciding presence
//   jev       presenceNarrowedExtractor, hosted Jev deciding presence
//
// Arms are interleaved per transcript, so drift in the chat deployment's load lands on all three.
//
//   node run.mjs [transcriptLimit] [arm,arm,...]
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  extractGroups,
  perGroupExtractor,
  presenceNarrowedExtractor,
} from "../../../packages/ribo-core/dist/index.js";
import { openAiChat } from "../../../packages/ribo-chat-openai/dist/index.js";
import { systemOnePresencePhase } from "../../../packages/ribo-extractor-systemone/dist/index.js";
import { systemOneClient } from "../../../packages/ribo-systemone-managed/dist/index.js";
import {
  snuggProAdapter,
  snuggGroupInstructions,
} from "../../../packages/ribo-adapter-snuggpro/dist/index.js";
import { loadEnv } from "../0008-typesafe-jev/env.mjs";
import { corpus } from "../0008-typesafe-jev/corpus.mjs";

const limit = Number(process.argv[2] ?? "99");
const arms = (process.argv[3] ?? "baseline,md-1,jev").split(",");
const env = loadEnv();

export const CHAT_MODEL = "gpt-5.6-luna";
// ADR 0027's [0.20, 0.50) bands with the band riding along in the same call — one threshold.
export const PRESENCE_THRESHOLD = 0.2;
// Questions per System One request; the client's default of 30 would make 16 sequential requests.
export const PRESENCE_BATCH = 100;

/** Counts every request through a transport, and sums the usage each response reports. */
function meter(inner, readUsage) {
  const m = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
  const fetchImpl = async (input, init) => {
    m.requests += 1;
    const res = await inner(input, init);
    if (!res.ok) m.failures += 1;
    else {
      const u = readUsage(await res.clone().json());
      m.inputTokens += u.input;
      m.outputTokens += u.output;
    }
    return res;
  };
  return { m, fetchImpl };
}

const chatMeter = () =>
  meter(fetch, (b) => ({
    input: b.usage?.prompt_tokens ?? 0,
    output: b.usage?.completion_tokens ?? 0,
  }));

const chatFor = (fetchImpl) =>
  openAiChat({
    apiKey: env.AZURE_AI_FOUNDRY_API_KEY,
    baseUrl: env.AZURE_AI_FOUNDRY_OPENAI_BASE_URL.replace(/\/$/, ""),
    fetchImpl,
  });

/** The host transport for each System One deployment: swap the SDK's placeholder credential. */
const systemOneTransport = {
  "md-1": {
    endpoint: `${new URL(env.AZURE_AI_FOUNDRY_OPENAI_BASE_URL).origin}/providers/microsoft`,
    model: "md-1",
    auth: (h) => {
      h.delete("authorization");
      h.set("api-key", env.AZURE_AI_FOUNDRY_API_KEY);
    },
  },
  jev: {
    endpoint: "https://api.typesafe.ai",
    model: "jev-latest",
    auth: (h) => h.set("authorization", `Bearer ${env.TYPESAFE_API_KEY}`),
  },
};

const groups = extractGroups(
  z.toJSONSchema(snuggProAdapter.extractionSchema, { target: "draft-2020-12" }),
);

function build(arm) {
  const chat = chatMeter();
  if (arm === "baseline") {
    const extractor = perGroupExtractor({
      target: snuggProAdapter,
      chat: chatFor(chat.fetchImpl),
      model: CHAT_MODEL,
      groupInstructions: snuggGroupInstructions,
      maxSerializedCharsPerGroup: 32_768,
      maxNullableUnionsPerGroup: Infinity,
    });
    return { extractor, chat: chat.m, presence: null };
  }
  const t = systemOneTransport[arm];
  const presence = meter(
    (input, init) => {
      const headers = new Headers(init?.headers);
      t.auth(headers);
      return fetch(input, { ...init, headers });
    },
    (b) => ({ input: b.usage?.input_tokens ?? 0, output: b.usage?.output_tokens ?? 0 }),
  );
  const client = systemOneClient({
    endpoint: t.endpoint,
    fetch: presence.fetchImpl,
    model: t.model,
    batchSize: PRESENCE_BATCH,
  });
  const extractor = presenceNarrowedExtractor(
    systemOnePresencePhase({
      client,
      schema: snuggProAdapter.extractionSchema,
      threshold: PRESENCE_THRESHOLD,
    }),
    {
      target: snuggProAdapter,
      groups,
      chat: chatFor(chat.fetchImpl),
      model: CHAT_MODEL,
      groupInstructions: snuggGroupInstructions,
    },
  );
  return { extractor, chat: chat.m, presence: presence.m };
}

const outRoot = fileURLToPath(new URL("./results/", import.meta.url));
const metrics = Object.fromEntries(arms.map((a) => [a, []]));

// ONLY=<transcript name> re-runs one cell, e.g. after a transport failure. TAG=<name> writes
// results/<arm>-<name>/ and metrics-<name>.json, keeping an earlier run to compare against.
const only = process.env.ONLY;
const tag = process.env.TAG ? `-${process.env.TAG}` : "";
for (const entry of corpus()
  .slice(0, limit)
  .filter((e) => !only || e.name === only)) {
  for (const arm of arms) {
    mkdirSync(`${outRoot}${arm}${tag}`, { recursive: true });
    const { extractor, chat, presence } = build(arm);
    const t0 = Date.now();
    let row;
    try {
      const result = await extractor.extract(
        { text: entry.transcript, annotations: [] },
        { deadline: Date.now() + 15 * 60_000 },
      );
      writeFileSync(
        `${outRoot}${arm}${tag}/${entry.name}.json`,
        JSON.stringify(result.fields, null, 2),
      );
      row = {
        name: entry.name,
        ok: true,
        ms: Date.now() - t0,
        usage: result.usage,
        chat,
        presence,
      };
    } catch (e) {
      row = {
        name: entry.name,
        ok: false,
        ms: Date.now() - t0,
        error: String(e).slice(0, 400),
        chat,
        presence,
      };
    }
    metrics[arm].push(row);
    console.log(
      `${entry.name.padEnd(28)} ${arm.padEnd(8)} ${row.ok ? "ok    " : "FAILED"} ` +
        `${String(row.ms).padStart(7)}ms  chat ${chat.requests} req (${chat.failures} failed) ` +
        `${chat.inputTokens} in / ${chat.outputTokens} out` +
        (presence ? `  | presence ${presence.requests} req ${presence.inputTokens} in` : "") +
        (row.ok ? "" : `  ${row.error.slice(0, 160)}`),
    );
    writeFileSync(`${outRoot}metrics${tag}.json`, JSON.stringify(metrics, null, 2));
  }
}
