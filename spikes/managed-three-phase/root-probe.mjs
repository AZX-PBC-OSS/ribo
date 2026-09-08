/** Is a non-object root schema what the route rejects? Two calls, identical but for the root. */
import { loadEnvLocal } from "./probe.mjs";

const env = loadEnvLocal();
const url = `${env.HELIX_BASE_URL}/_api/llm/chat`;

const bare = { anyOf: [{ type: "number" }, { type: "null" }] };
const wrapped = {
  type: "object",
  properties: { value: bare },
  required: ["value"],
  additionalProperties: false,
};

for (const [label, schema] of [
  ["bare-anyOf-root", bare],
  ["bare-number-root", { type: "number" }],
  ["wrapped-object-root", wrapped],
]) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.HELIX_ORIGIN,
      authorization: `Bearer ${env.HELIX_DEV_TOKEN}`,
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      system: "Classify the quote into the field value.",
      messages: [{ role: "user", content: "we measured R-30 up there" }],
      stream: false,
      maxTokens: 256,
      responseFormat: { type: "json_schema", name: "classify", schema },
    }),
  });
  console.log(label, res.status, (await res.text()).slice(0, 220));
}
