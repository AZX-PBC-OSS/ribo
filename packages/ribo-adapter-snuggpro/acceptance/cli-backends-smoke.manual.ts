import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { cliChat } from "@azx/ribo-cli";
import type { CliShapeResult } from "@azx/ribo-cli";

/**
 * The key-free smoke for the two CLI backends: ONE live call per backend,
 * against the real installed binary.
 *
 * MANUAL, OPT-IN — it makes a real model call, so it is never wired into CI
 * or into `./check.sh`. It is picked up by `vitest.acceptance.config.ts`'s
 * `**\/*.manual.ts` glob; run it by name:
 *
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts cli-backends-smoke
 *
 * It imports `cliChat` from `@azx/ribo-cli` by the SAME specifier the
 * acceptance gate uses, so a broken gate import is caught here first — by a
 * cheap smoke — rather than by a paid run.
 *
 * It skips cleanly when the binary is not installed: a machine without
 * `claude` is not a failure of this file.
 */

/** The tiny schema the smoke asks for: one boolean, nothing else. */
const SMOKE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

/** Is the binary installed and answering? Probed once, at module scope. */
const hasBinary = (binary: string): boolean => {
  const probe = spawnSync(binary, ["--version"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
};

/** One live call: the reply parses, and the transport says it conformed. */
const smoke = async (backend: "claude" | "codex"): Promise<void> => {
  const shapeResults: CliShapeResult[] = [];
  const chat = cliChat({ backend, onShapeResult: (result) => shapeResults.push(result) });

  const completion = await chat.complete({
    model: "ribo-smoke",
    messages: [
      { role: "system", content: "Answer with a JSON object and nothing else." },
      { role: "user", content: "Reply with ok set to true." },
    ],
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "smoke", schema: SMOKE_SCHEMA, strict: true },
    },
  });

  const parsed = JSON.parse(completion.content) as { ok?: unknown };
  expect(parsed.ok).toBe(true);
  expect(shapeResults).toEqual([
    { backend, attempts: shapeResults[0]?.attempts ?? 0, conforming: true },
  ]);
};

describe("the CLI backends, live", () => {
  test.skipIf(!hasBinary("claude"))("claude answers a schema-conforming reply", async () => {
    await smoke("claude");
  });

  test.skipIf(!hasBinary("codex"))("codex answers a schema-conforming reply", async () => {
    await smoke("codex");
  });
});
