/**
 * @file The browser side of the dev-only `/api/extract` endpoint.
 *
 * Same-origin `fetch` to the Vite server's `/api/extract` middleware (see
 * `playground/vite-extract.ts`). The inference runs SERVER-SIDE, so the browser
 * never holds a key. This module is a thin transport; the panel owns the state.
 */

/** The active backend, reported by `GET /api/extract`. */
export interface ExtractStatus {
  /**
   * The resolved backend: an agentic CLI (`claude`, `codex` or `opencode`,
   * auto-detected on PATH), `openai` (when `OPENAI_API_KEY` is set), or `none`
   * when no backend is available on this machine.
   */
  readonly backend: "claude" | "codex" | "opencode" | "openai" | "none";
  /** The model label to show in the banner (e.g. `gpt-5.6`, or the CLI's name). */
  readonly model: string;
  /** Only when `backend` is `none`: why no backend resolved. */
  readonly error?: string;
}

/** A successful extraction, from `POST /api/extract`. */
export interface ExtractResult {
  readonly fields: Record<string, unknown>;
  readonly backend: string;
  readonly model: string;
}

/** Report the active backend for the banner. */
export async function fetchExtractStatus(): Promise<ExtractStatus> {
  const response = await fetch("/api/extract", { method: "GET" });
  if (!response.ok) throw new Error(`status ${String(response.status)}`);
  return (await response.json()) as ExtractStatus;
}

/**
 * Run one extraction. `schema` is sent as the raw editor string (the server parses
 * and validates it). A non-2xx response carries `{ error }`, which is thrown as the
 * message the panel shows.
 */
export async function runExtract(schema: string, text: string): Promise<ExtractResult> {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema, text }),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    fields?: Record<string, unknown>;
    backend?: string;
    model?: string;
  } | null;
  if (!response.ok || payload === null) {
    throw new Error(payload?.error ?? `extraction failed (HTTP ${String(response.status)})`);
  }
  return {
    fields: payload.fields ?? {},
    backend: payload.backend ?? "codex",
    model: payload.model ?? "",
  };
}
