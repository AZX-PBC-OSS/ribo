import { useCallback, useEffect, useRef, useState } from "react";
import { json } from "@codemirror/lang-json";
import CodeMirror from "@uiw/react-codemirror";
import { isSpanGrounded } from "@azx/ribo-core";

import { fetchExtractStatus, runExtract, type ExtractStatus } from "./extract-api.js";
import { DEFAULT_SCHEMA, LARGER_SCHEMA } from "./examples/schemas.js";
import { DEFAULT_TEXT, TRANSCRIPT_EXAMPLES } from "./examples/transcripts.js";
import { messageOf } from "./format.js";
import { button, errorBox, monospace, muted, noticeBox, panel } from "./styles.js";

/**
 * @file "Try it" — a DEV-ONLY tool to paste a JSON Schema + some text and get a
 * real extraction into that schema, with provenance.
 *
 * The inference runs SERVER-SIDE, in the Vite dev/preview server's own
 * `/api/extract` middleware (`playground/vite-extract.ts`) — same-origin, no CORS,
 * no key in the browser bundle. The middleware auto-detects a backend: an
 * OpenAI-compatible endpoint when `OPENAI_API_KEY` is set, else the first keyless
 * agentic CLI on PATH (`claude`, `codex` or `opencode`). This is a local developer
 * convenience, not a shipped feature: a real deployment routes extraction through
 * the Helix proxy.
 *
 * The provenance rendering mirrors `ReviewPanel`: each non-null value is shown with
 * its `sourceSpan` and a ✓/⚠ flag from `isSpanGrounded` against the source text, so
 * a reviewer can confirm the model quoted the text rather than inventing a value.
 */

// ---- provenance rendering (mirrors ReviewPanel's grounding view) -------------

interface Envelope {
  readonly value: unknown;
  readonly confidence: unknown;
  readonly sourceSpan: string | null;
}

function isEnvelope(candidate: unknown): candidate is Envelope {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "value" in candidate &&
    "sourceSpan" in candidate &&
    "confidence" in candidate
  );
}

interface Leaf {
  readonly path: string;
  readonly envelope: Envelope;
}

/** Walk the extracted object into `{ path, envelope }` leaves, recursing nested objects. */
function flatten(fields: Record<string, unknown>, prefix = ""): Leaf[] {
  const leaves: Leaf[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isEnvelope(value)) {
      leaves.push({ path, envelope: value });
    } else if (typeof value === "object" && value !== null) {
      leaves.push(...flatten(value as Record<string, unknown>, path));
    }
  }
  return leaves;
}

/** `heatingFuel` -> "Heating fuel"; nested keys join with ` · `. */
function humanize(path: string): string {
  return path
    .split(".")
    .map((segment) =>
      segment
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (char) => char.toUpperCase())
        .trim(),
    )
    .join(" · ");
}

// ---- the panel ---------------------------------------------------------------

interface RunResult {
  readonly fields: Record<string, unknown>;
  readonly backend: string;
  readonly model: string;
  /** The exact source text the run used — grounding is checked against THIS. */
  readonly text: string;
}

const editorWrap = {
  border: "1px solid #d0d7de",
  borderRadius: 6,
  marginTop: "0.35rem",
  overflow: "hidden",
} as const;

export function TryItPanel() {
  const [schema, setSchema] = useState(DEFAULT_SCHEMA);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [status, setStatus] = useState<ExtractStatus | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchExtractStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A missing status is not fatal — the endpoint is dev-only and the banner
        // simply stays in its "checking" state. Running still reports the backend.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const schemaJsonError = jsonError(schema);

  const run = useCallback(() => {
    setError(undefined);
    setRunning(true);
    const ranAgainst = text;
    void runExtract(schema, ranAgainst)
      .then((res) => {
        setResult({ ...res, text: ranAgainst });
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setRunning(false);
      });
  }, [schema, text]);

  const onUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void file.text().then((contents) => {
      setText(contents);
    });
    // Allow re-uploading the same file (onChange won't fire otherwise).
    event.target.value = "";
  }, []);

  return (
    <section style={panel}>
      <h2>5 · Try it — extract into any schema</h2>
      <p style={muted}>
        Paste a JSON Schema and some text, press <em>Run</em>, and get a real extraction into that
        schema with provenance. The model runs <strong>server-side</strong> in this dev server (
        <code style={monospace}>/api/extract</code>) — no key reaches the browser.
      </p>

      <BackendBanner status={status} />

      <div style={{ marginTop: "1rem" }}>
        <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <strong>JSON Schema</strong>
          <span style={muted}>each field a</span>
          <code style={monospace}>{"{ value, confidence, sourceSpan }"}</code>
          <span style={muted}>envelope</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.35rem" }}>
          <button type="button" style={smallButton} onClick={() => setSchema(DEFAULT_SCHEMA)}>
            Starter schema
          </button>
          <button type="button" style={smallButton} onClick={() => setSchema(LARGER_SCHEMA)}>
            Larger example
          </button>
        </div>
        <div style={editorWrap}>
          <CodeMirror
            value={schema}
            height="220px"
            extensions={[json()]}
            onChange={setSchema}
            data-testid="schema-editor"
          />
        </div>
        {schemaJsonError !== undefined && (
          <p style={{ ...muted, color: "#bf8700", margin: "0.3rem 0 0" }}>
            ⚠ Schema is not valid JSON yet: {schemaJsonError}
          </p>
        )}
      </div>

      <div style={{ marginTop: "1rem" }}>
        <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <strong>Source text</strong>
          <span style={muted}>the untrusted input to extract from</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.35rem" }}>
          {TRANSCRIPT_EXAMPLES.map((example) => (
            <button
              key={example.id}
              type="button"
              style={smallButton}
              onClick={() => setText(example.text)}
            >
              {example.label}
            </button>
          ))}
          <button type="button" style={smallButton} onClick={() => fileInputRef.current?.click()}>
            Upload .txt…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            onChange={onUpload}
            style={{ display: "none" }}
            data-testid="text-upload"
          />
        </div>
        <div style={editorWrap}>
          <CodeMirror
            value={text}
            height="220px"
            onChange={setText}
            basicSetup={{ lineNumbers: false, foldGutter: false }}
            data-testid="text-editor"
          />
        </div>
      </div>

      <div style={{ alignItems: "center", display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
        <button
          type="button"
          style={button}
          onClick={run}
          disabled={running || text.trim() === "" || schemaJsonError !== undefined}
          data-testid="try-it-run"
        >
          {running ? "Extracting…" : "Run extraction"}
        </button>
        {running && (
          <span style={muted}>
            <Spinner /> the model is working — this can take ~30s.
          </span>
        )}
      </div>

      {error !== undefined && <p style={errorBox}>{error}</p>}

      {result !== undefined && <ResultView result={result} />}
    </section>
  );
}

/** The active-backend banner, plus the one honest line about what this endpoint is. */
function BackendBanner({ status }: { status: ExtractStatus | undefined }) {
  const line = backendLine(status);
  return (
    <div style={noticeBox} data-testid="try-it-backend">
      <p style={{ margin: 0 }}>
        <strong>{line}</strong>
      </p>
      <p style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
        This runs a model on your machine via a dev-only endpoint; a real deployment routes
        extraction through the Helix proxy.
      </p>
    </div>
  );
}

/**
 * The banner's headline. The keyless CLI backends (claude, codex, opencode) read
 * as `Extraction: <name>, keyless — local dev endpoint`, adding `(model)` only
 * when the model label differs from the backend name (so `codex (gpt-5.6)` keeps
 * its version but `claude` is not written `claude (claude)`).
 */
function backendLine(status: ExtractStatus | undefined): string {
  if (status === undefined) return "Extraction: checking the dev endpoint…";
  if (status.backend === "openai") return `Extraction: OpenAI (${status.model})`;
  if (status.backend === "none") {
    return status.error ?? "Extraction: no backend available on this machine.";
  }
  const label =
    status.model !== "" && status.model !== status.backend
      ? `${status.backend} (${status.model})`
      : status.backend;
  return `Extraction: ${label}, keyless — local dev endpoint`;
}

function ResultView({ result }: { result: RunResult }) {
  const leaves = flatten(result.fields);
  const stated = leaves.filter((leaf) => leaf.envelope.value !== null);
  const addressed = leaves.filter(
    (leaf) => leaf.envelope.value === null && leaf.envelope.sourceSpan !== null,
  );
  const silent = leaves.filter(
    (leaf) => leaf.envelope.value === null && leaf.envelope.sourceSpan === null,
  );

  return (
    <div data-testid="try-it-result" style={{ marginTop: "1rem" }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <strong>Extracted fields</strong>
        <span style={muted}>
          {stated.length} stated · {addressed.length} addressed, not stated · {silent.length} silent
          · via <code style={monospace}>{result.backend}</code>
        </span>
      </div>

      {leaves.length === 0 ? (
        <p style={{ ...muted, margin: "0.5rem 0 0" }}>
          The output had no <code style={monospace}>{"{ value, confidence, sourceSpan }"}</code>{" "}
          envelopes to show. Raw output below.
        </p>
      ) : (
        <dl style={{ margin: "0.6rem 0 0" }}>
          {[...stated, ...addressed].map((leaf) => (
            <FieldRow key={leaf.path} leaf={leaf} text={result.text} />
          ))}
        </dl>
      )}

      {silent.length > 0 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ ...muted, cursor: "pointer" }}>
            {silent.length} field{silent.length === 1 ? "" : "s"} not stated in this text
          </summary>
          <p style={{ ...muted, margin: "0.4rem 0 0" }}>
            {silent.map((leaf) => humanize(leaf.path)).join(", ")}.
          </p>
        </details>
      )}

      <details style={{ marginTop: "0.6rem" }}>
        <summary style={{ ...muted, cursor: "pointer" }}>Raw JSON</summary>
        <pre style={{ ...monospace, fontSize: "0.8rem", overflowX: "auto" }}>
          {JSON.stringify(result.fields, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function FieldRow({ leaf, text }: { leaf: Leaf; text: string }) {
  const { value, sourceSpan } = leaf.envelope;
  const grounded = isSpanGrounded(sourceSpan, text);

  return (
    <div style={{ borderTop: "1px solid #f6f8fa", padding: "0.4rem 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        <span style={{ fontWeight: 600 }}>{humanize(leaf.path)}</span>
        {value === null ? (
          <span style={muted}>not stated (addressed in the text)</span>
        ) : (
          <span style={monospace}>{String(value)}</span>
        )}
      </div>
      {sourceSpan !== null && (
        <div style={{ ...muted, marginTop: "0.15rem" }}>
          <span
            style={{ color: grounded ? "#1f883d" : "#bf8700", fontWeight: 600 }}
            title={
              grounded
                ? "verbatim substring of the source text"
                : "not found in the source text — the model may have invented this quote"
            }
          >
            {grounded ? "✓ in the text" : "⚠ not in the text"}
          </span>{" "}
          <q>{sourceSpan}</q>
        </div>
      )}
    </div>
  );
}

const smallButton = { ...button, fontSize: "0.8rem", padding: "0.25rem 0.6rem" } as const;

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        animation: "ribo-spin 0.8s linear infinite",
        border: "2px solid #d0d7de",
        borderRadius: "50%",
        borderTopColor: "#1f883d",
        display: "inline-block",
        height: 12,
        marginRight: 4,
        verticalAlign: "-1px",
        width: 12,
      }}
    >
      <style>{"@keyframes ribo-spin { to { transform: rotate(360deg); } }"}</style>
    </span>
  );
}

/** Basic JSON validity feedback for the schema editor: the parse error, or undefined. */
function jsonError(source: string): string | undefined {
  try {
    JSON.parse(source);
    return undefined;
  } catch (cause) {
    return messageOf(cause);
  }
}
