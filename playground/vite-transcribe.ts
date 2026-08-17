/**
 * @file `/api/transcribe` — the server side of the playground's managed
 * transcription path. **DEV/PREVIEW ONLY. NEVER in the production bundle.**
 *
 * A Vite plugin mounting a same-origin `/api/transcribe` endpoint that forwards a
 * multipart body to Azure AI Speech Fast Transcription, attaching the subscription
 * key **server-side, inside the Vite process**. Same shape and same reasoning as
 * `vite-extract.ts`: the browser never holds a key, and there is no CORS hop.
 *
 * ## Why this exists rather than a key in the browser
 *
 * `@azx/ribo-transcriber-managed` deliberately has **no capacity to authenticate**
 * — no token option, no key option (design §5.2). It builds the Azure request and
 * hands it to an injected `fetch`; how that call is routed and credentialed is the
 * host's business. This endpoint is the development half of that contract.
 *
 * The production half is Helix's `/_api/fetch/<url>`, where the edge injects the
 * stored `azure-stt` connection secret. **The two are structurally identical** — a
 * same-origin POST that gets a credential attached somewhere the browser cannot
 * see — so swapping development for production is a change to the transport in
 * `managed-transcriber-store.ts` and nothing else. No package release, no key ever
 * reaching a bundle.
 *
 * ## Configuration
 *
 * Read from `process.env` (the Vite process), never `import.meta.env` — a
 * `VITE_`-prefixed variable would be **inlined into the built bundle**, which is
 * exactly the failure this endpoint exists to avoid:
 *
 * - `AZURE_AI_FOUNDRY_API_KEY` — the Speech resource key.
 * - `AZURE_AI_FOUNDRY_OPENAI_BASE_URL` — any URL on the resource; only its host is
 *   used, to derive the Speech endpoint.
 *
 * With neither set the endpoint answers `503` and a clear message, and the managed
 * transcriber simply reports `not-configured` — the playground still runs on the
 * on-device engine alone.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

/** The Fast Transcription api-version. `phraseList` does not exist before this one. */
const API_VERSION = "2025-10-15";

/** Derive the Speech transcribe endpoint from any URL on the same resource. */
export function speechEndpointFrom(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const { host } = new URL(baseUrl);
    return `https://${host}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
  } catch {
    return undefined;
  }
}

/** Read the whole request body. The audio is small — a field dictation, not a film. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, { error: "POST only" });
    return;
  }

  const key = process.env.AZURE_AI_FOUNDRY_API_KEY;
  const endpoint = speechEndpointFrom(process.env.AZURE_AI_FOUNDRY_OPENAI_BASE_URL);
  if (!key || !endpoint) {
    send(res, 503, {
      error:
        "Managed transcription is not configured. Set AZURE_AI_FOUNDRY_API_KEY and " +
        "AZURE_AI_FOUNDRY_OPENAI_BASE_URL in .env.local at the repo root, then restart the dev server.",
    });
    return;
  }

  try {
    const body = await readBody(req);
    // Forward the multipart body verbatim, including its boundary — the client
    // built the parts (`audio`, `definition`) and re-parsing them here would only
    // introduce a second place for the request shape to drift.
    const contentType = req.headers["content-type"];
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        ...(contentType ? { "content-type": contentType } : {}),
      },
      body: new Uint8Array(body),
    });

    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    // Pass the upstream status through unchanged: the transcriber's failure
    // classification reads it, and rewriting a 401 or a 413 into a 500 here would
    // turn a capability failure or a terminal one into an endless retry.
    res.end(text);
  } catch (cause) {
    send(res, 502, {
      error: `Upstream transcription request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

export function transcribeApiPlugin(): Plugin {
  const mount = (middlewares: {
    use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
  }): void => {
    middlewares.use("/api/transcribe", (req, res) => {
      void handle(req, res);
    });
  };
  return {
    name: "ribo-transcribe-api",
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
