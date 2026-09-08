/** Verify the provisioned dev gateway answers a structured-output call. */
import { loadEnvLocal } from "./probe.mjs";

const env = loadEnvLocal();
const url = `${env.HELIX_BASE_URL}/_api/llm/chat`;

for (const model of ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.HELIX_ORIGIN,
      authorization: `Bearer ${env.HELIX_DEV_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      system: "Answer with JSON only.",
      messages: [{ role: "user", content: "The attic R-value is 30." }],
      stream: false,
      maxTokens: 256,
      responseFormat: {
        type: "json_schema",
        name: "t",
        schema: {
          type: "object",
          properties: { rvalue: { anyOf: [{ type: "number" }, { type: "null" }] } },
          required: ["rvalue"],
          additionalProperties: false,
        },
      },
    }),
  });
  console.log(model, res.status, (await res.text()).slice(0, 300));
}
