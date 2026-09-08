import { describe, expect, test } from "vitest";
import { z } from "zod";

import { snuggProAdapter } from "@azx/ribo-adapter-snuggpro";
import { threePhaseExtractor } from "@azx/ribo-extractor-ondevice";
import type { CapableChatClient } from "@azx/ribo-extractor-openai";

describe("shape diagnostic", () => {
  test("what does three-phase see in the current snuggpro extraction schema?", async () => {
    const schema = z.toJSONSchema(snuggProAdapter.extractionSchema, {
      target: "draft-2020-12",
    }) as Record<string, any>;
    for (const [k, v] of Object.entries(schema.properties as Record<string, any>)) {
      console.log(
        `group ${k}: type=${v.type} hasProperties=${v.properties !== undefined} isArray=${v.type === "array"}`,
      );
    }

    const seen: string[] = [];
    const fake: CapableChatClient = {
      engine: "fake",
      async capability() {
        return { status: "ready" } as const;
      },
      async complete(req) {
        seen.push(req.response_format.json_schema.name);
        throw new Error("no model");
      },
    };
    const ex = threePhaseExtractor({ target: snuggProAdapter, chat: fake });
    let err: unknown = null;
    try {
      await ex.extract("hello world");
    } catch (e) {
      err = e;
    }
    console.log("calls attempted:", JSON.stringify(seen));
    console.log("error:", err instanceof Error ? err.message.slice(0, 800) : String(err));
    expect(true).toBe(true);
  });
});
