/**
 * Provision the throwaway Helix app this measurement spike calls through.
 *
 * `helixChat` needs three things that did not exist when this spike started: an app
 * whose manifest grants `capabilities.llm`, a dev-gateway origin registration, and a
 * dev token. The repo's only Helix app (`ribo-docs`) is the documentation site and
 * grants no LLM capability, and the `HELIX_DEV_TOKEN` in `.env.local` no longer
 * authenticates. Rather than mutate the live docs app's manifest, this creates a
 * dedicated app that can be archived when the measurement is done.
 *
 * Run: node docs/spikes/0006-managed-three-phase/setup-app.mjs
 */
import { portal } from "./portal.mjs";

const SLUG = "ribo-extraction-spike";
const ORIGIN = "http://localhost:5173";
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

async function show(label, r) {
  console.log(`${label} -> ${r.status}\n  ${r.text.slice(0, 600)}`);
  return r;
}

const apps = JSON.parse((await portal("/api/v1/apps")).text);
if (!apps.some((a) => a.slug === SLUG)) {
  await show(
    "create",
    await portal("/api/v1/apps", {
      method: "POST",
      body: JSON.stringify({
        slug: SLUG,
        displayName: "Ribo Extraction Spike",
        visibility: { mode: "internal" },
      }),
    }),
  );
} else {
  console.log("create -> already exists");
}

await show(
  "manifest",
  await portal(`/api/v1/apps/${SLUG}/manifest`, {
    method: "PUT",
    body: JSON.stringify({
      app: SLUG,
      visibility: { mode: "internal" },
      capabilities: {
        llm: { models: MODELS, dollarsPerDay: 25 },
        mcp: [],
        externalOrigins: [],
      },
    }),
  }),
);

await show(
  "dev-token",
  await portal(`/api/v1/apps/${SLUG}/dev-tokens`, {
    method: "POST",
    body: JSON.stringify({ label: "extraction-spike", origins: [ORIGIN] }),
  }),
);
