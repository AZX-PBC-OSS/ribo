import { useEffect, useState } from "react";
import { isSpanGrounded, type Outbox, type OutboxItem } from "@azx/ribo-core";

import { extractorStatus } from "./extractor-store.js";
import { messageOf } from "./format.js";
import { errorBox, monospace, muted, noticeBox, panel, statusBadge } from "./styles.js";

/**
 * @file The extraction becomes visible: the fields an extractor pulled from a
 * recording, each with the verbatim quote that justifies it.
 *
 * This is the review surface for Phase 4's `extracting` step. It reads
 * `item.extracted` off every outbox row that has reached (or passed) extraction and
 * shows, per field, the value and its `sourceSpan` — so a reviewer can confirm each
 * value was actually said. Two honest caveats sit at the top, on purpose:
 *
 *   1. **Which extractor is live** — sample data (`FakeExtractor`) vs a real model —
 *      so replayed fixture fields are never mistaken for a real extraction.
 *   2. **A verbatim span is not proof the audio was heard right.** The grounding
 *      check confirms the model quoted the transcript, not that the transcript is
 *      correct — a mic that hears "Lennox" as "Linux" yields a perfectly grounded
 *      span for the wrong word.
 *
 * ## The null-heavy reality
 *
 * `SnuggFields` is ~35 slots and most are `null` on any one recording — an auditor
 * in a basement does not narrate the window glazing. Rendering 35 empty rows as if
 * they were findings is noise, so a field is shown as a finding only when it has a
 * value or an explaining span (BTU "painted over", blower door "deferred"); the
 * silent nulls collapse into a count.
 */

/** The provenance envelope, as it comes back off `item.extracted` (loose `unknown`). */
interface Envelope {
  readonly value: unknown;
  readonly confidence: number;
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

/**
 * Walk the extracted object into `{ path, envelope }` leaves. Flat fields are one
 * level; the health-and-safety matrix is a nested object of envelopes, so recurse
 * into any plain object that is not itself an envelope.
 */
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

/** `heatingEquipmentType` → "Heating equipment type"; nested keys join with ` · `. */
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

export function ReviewPanel({ outbox }: { outbox: Outbox }) {
  const [items, setItems] = useState<OutboxItem[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const subscription = outbox.items$.subscribe({
      next: setItems,
      error: (cause: unknown) => {
        setError(messageOf(cause));
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [outbox]);

  const extracted = items?.filter((item) => item.extracted !== undefined) ?? [];

  return (
    <section style={panel}>
      <h2>4 · Review extracted fields</h2>
      <p style={muted}>
        The <code style={monospace}>extracting</code> step turns each transcript into structured
        Snugg Pro fields, with the verbatim quote that justifies every value. Drain the queue above
        (<em>sync now</em>, or <em>Transcribe</em>) and the fields appear here.
      </p>

      <ExtractorBanner />
      <MeasurementCaveat />

      {error !== undefined && <p style={errorBox}>{error}</p>}

      {items === undefined ? (
        <p style={muted}>reading the outbox…</p>
      ) : extracted.length === 0 ? (
        <p data-testid="review-empty" style={muted}>
          Nothing extracted yet — record something, then drain the queue so an item reaches the{" "}
          <code style={monospace}>extracting</code> step.
        </p>
      ) : (
        <ol style={{ listStyle: "none", margin: "1rem 0 0", padding: 0 }}>
          {extracted.map((item) => (
            <ReviewCard key={item.id} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** The active-extractor line — sample data vs live model — plus the browser-key caveat. */
function ExtractorBanner() {
  if (extractorStatus.mode === "fake") {
    return (
      <div style={noticeBox} data-testid="extractor-status">
        <strong>Extraction: sample data (FakeExtractor).</strong> These fields are replayed from a
        fixture (the Delgado oil-boiler dictation), <em>not</em> extracted from this
        recording&rsquo;s audio — so their quotes will not be found in this transcript, which is
        exactly what the grounding check below reports. Set{" "}
        <code style={monospace}>VITE_OPENAI_API_KEY</code> (and a CORS-OK{" "}
        <code style={monospace}>VITE_OPENAI_BASE_URL</code>) to run a live model instead.
      </div>
    );
  }
  return (
    <div style={noticeBox} data-testid="extractor-status">
      <p style={{ margin: 0 }}>
        <strong>
          Extraction: live — <code style={monospace}>{extractorStatus.model}</code> via{" "}
          <code style={monospace}>{extractorStatus.baseUrl}</code>.
        </strong>
      </p>
      <p style={{ margin: "0.4rem 0 0" }}>
        ⚠ Dev-only. <code style={monospace}>VITE_OPENAI_API_KEY</code> is inlined into the browser
        bundle, so this path ships the key to every visitor — the reason a browser-direct call is a
        bad idea (it is why OpenAI&rsquo;s SDK gates the browser behind{" "}
        <code style={monospace}>dangerouslyAllowBrowser</code>). Keep the key server-side: the Helix
        proxy in production, or a local proxy, as{" "}
        <code style={monospace}>VITE_OPENAI_BASE_URL</code>. Never ship a real key this way.
      </p>
    </div>
  );
}

/** The Lennox→"Linux" caveat: a grounded span proves the quote, not the hearing. */
function MeasurementCaveat() {
  return (
    <p style={{ ...muted, margin: "0.5rem 0 0" }}>
      <strong>Reading the ✓ / ⚠ flags:</strong> a ✓ means the value&rsquo;s quote is a verbatim
      substring of this recording&rsquo;s transcript — it proves the model did not <em>invent</em>{" "}
      the quote. It does <em>not</em> prove the audio was heard correctly: a mic that hears
      &ldquo;Lennox&rdquo; as &ldquo;Linux&rdquo; yields a perfectly ✓ span for the wrong word.
      Confirm each value against what you know was said.
    </p>
  );
}

function ReviewCard({ item }: { item: OutboxItem }) {
  const transcript = item.transcript?.text ?? "";
  const leaves = flatten((item.extracted ?? {}) as Record<string, unknown>);

  const stated = leaves.filter((leaf) => leaf.envelope.value !== null);
  const addressed = leaves.filter(
    (leaf) => leaf.envelope.value === null && leaf.envelope.sourceSpan !== null,
  );
  const silent = leaves.filter(
    (leaf) => leaf.envelope.value === null && leaf.envelope.sourceSpan === null,
  );

  return (
    <li data-testid="review-card" style={{ borderTop: "1px solid #eaeef2", padding: "0.85rem 0" }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
        <strong style={monospace}>#{item.seq}</strong>
        <span style={statusBadge(item.status)}>{item.status}</span>
        <span style={muted}>
          {stated.length} stated · {addressed.length} addressed, not stated · {silent.length} silent
        </span>
      </div>

      {stated.length === 0 && addressed.length === 0 ? (
        <p style={{ ...muted, margin: "0.5rem 0 0" }}>
          Nothing was stated in this recording — every field is <code style={monospace}>null</code>.
        </p>
      ) : (
        <dl style={{ margin: "0.6rem 0 0" }}>
          {stated.map((leaf) => (
            <FieldRow key={leaf.path} leaf={leaf} transcript={transcript} />
          ))}
          {addressed.map((leaf) => (
            <FieldRow key={leaf.path} leaf={leaf} transcript={transcript} />
          ))}
        </dl>
      )}

      {silent.length > 0 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ ...muted, cursor: "pointer" }}>
            {silent.length} field{silent.length === 1 ? "" : "s"} not stated in this recording
          </summary>
          <p style={{ ...muted, margin: "0.4rem 0 0" }}>
            {silent.map((leaf) => humanize(leaf.path)).join(", ")}.
          </p>
        </details>
      )}
    </li>
  );
}

function FieldRow({ leaf, transcript }: { leaf: Leaf; transcript: string }) {
  const { value, sourceSpan } = leaf.envelope;
  const grounded = isSpanGrounded(sourceSpan, transcript);

  return (
    <div style={{ borderTop: "1px solid #f6f8fa", padding: "0.4rem 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        <span style={{ fontWeight: 600 }}>{humanize(leaf.path)}</span>
        {value === null ? (
          <span style={muted}>not stated (the auditor addressed it)</span>
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
                ? "verbatim substring of this recording's transcript"
                : "not found in this recording's transcript"
            }
          >
            {grounded ? "✓ said aloud" : "⚠ not in this transcript"}
          </span>{" "}
          <q>{sourceSpan}</q>
        </div>
      )}
    </div>
  );
}
