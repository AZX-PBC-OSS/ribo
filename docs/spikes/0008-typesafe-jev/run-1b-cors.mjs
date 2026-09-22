// Probe 1b: does the API return access-control-allow-origin for any origin a browser would send?
// Without that header the browser blocks the response regardless of what the server does.
import { apiKey, API } from "./env.mjs";

const key = apiKey();
const origins = [
  "http://localhost:5173",
  "https://localhost:5173",
  "https://app.typesafe.ai",
  "https://example.com",
  "null",
];

const body = JSON.stringify({
  state: "ping",
  model: "jev-latest",
  questions: { ok: { type: "noul", instructions: "Is this a ping?" } },
});

for (const origin of origins) {
  const pre = await fetch(API, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  const allow = pre.headers.get("access-control-allow-origin");
  const post = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Origin: origin },
    body,
  });
  const postAllow = post.headers.get("access-control-allow-origin");
  console.log(
    `origin=${origin.padEnd(26)} preflight=${pre.status} allow-origin=${allow ?? "(absent)"}` +
      `  |  POST=${post.status} allow-origin=${postAllow ?? "(absent)"}`,
  );
  await post.text();
}
