import { useEffect, useMemo, useSyncExternalStore, type ChangeEvent } from "react";
import { z } from "zod";
import { parseFieldPath, stripOptionalNullable } from "@azx/ribo-core";
import type {
  FieldDecision,
  FieldPath,
  ReviewField,
  ReviewFields,
  SessionItem,
} from "@azx/ribo-core";
import { useReview, useSessions } from "@azx/ribo-ui-react";
import { snuggProAdapter, snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";
import { ONDEVICE_CHAT_ENGINE } from "@azx/ribo-extractor-ondevice";

import { getConnectivity } from "./connectivity-store.js";
import {
  extractorComposite,
  extractorStatus,
  wireExtractorConnectivity,
} from "./extractor-store.js";
import {
  getOnDeviceExtractorState,
  primeOnDeviceExtractor,
  startOnDeviceExtractor,
  subscribeToOnDeviceExtractor,
  type OnDeviceExtractorState,
} from "./ondevice-extractor-store.js";
import {
  betaBadge,
  button,
  errorBox,
  monospace,
  muted,
  noticeBox,
  panel,
  statusBadge,
} from "./styles.js";

/**
 * @file The review surface: every leaf of an extraction draft, one decision at a
 * time — accept it, correct it, or drop it — then submit or discard the whole
 * item.
 *
 * ## Where the data comes from now
 *
 * `useOutboxItems({ status: "awaiting-review" })` replaces the old "every item
 * with an `extracted`" filter: `queue/relay.ts` now parks an extracted item at
 * `awaiting-review` and stops seeing it, so this panel is the only thing that can
 * move it on. `useReview(item, { valuesSchema: snuggValuesSchema })` per item then
 * does the walk that used to be this file's own `flatten()` — and does it better:
 * `ReviewFields` is computed from `snuggValuesSchema` itself, not from
 * `item.extracted`, so a leaf the model omitted is presented with the sentinel
 * envelope instead of silently missing from the card. A field that vanishes is
 * indistinguishable to the auditor from one that was extracted correctly, which
 * is exactly the silence the schema walk exists to prevent.
 *
 * ## The panel is schema-driven, not Snugg-driven
 *
 * `snuggValuesSchema` and `snuggProAdapter.requiredOnCreate` are imported once, at
 * module scope, to hand to `useReview` — that is the only Snugg Pro knowledge in
 * this file. Every row renders off
 * `ReviewField.schema`: a `z.enum` gets a `<select>` built from the schema's own
 * members, a `z.number()` gets a numeric input, and anything else falls back to a
 * plain text box whose value round-trips through the schema at submit time. There
 * is no field-name switch and no per-field label table beyond `humanize` — if a
 * row ever needed a special case, that would be a sign the information belongs on
 * the schema, not here. This is what lets the field set change (51 leaves under
 * seven resource groups today, and counting) without a UI edit.
 *
 * ## Grouping is generic and instance-aware
 *
 * A card's leaves are grouped by the **first segment of the path** and then by the
 * bracketed instance key (`"hvac[k1]"`), derived from {@link parseFieldPath} rather
 * than by naming Snugg Pro's seven resource groups. A leaf path with no group
 * segment (a flat adapter) falls into one shared, unnamed group. Collection groups
 * render each instance as a subsection with an add/remove affordance; an empty-but-
 * present collection renders the group with an add affordance so the auditor can
 * still notice it was missed.
 *
 * ## The gate
 *
 * Submit is disabled while any **untouched, ungrounded** leaf remains —
 * `untouched.some((path) => fields[path]?.isGrounded === false)`. Those are
 * exactly the leaves whose quote is not a verbatim substring of the transcript:
 * the ones a human must actually look at before this card can leave the device.
 * `untouched` (not `decisionOf`'s accepted-by-default view) is what makes that
 * enforceable — a leaf nobody has acted on is not the same as one explicitly
 * accepted, even though `submit()` itself defaults every untouched leaf to
 * accepted once the gate opens.
 */

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

/** The last path segment, humanized for the row label inside its group/instance. */
function leafLabel(path: FieldPath): string {
  const dot = path.lastIndexOf(".");
  return humanize(dot === -1 ? path : path.slice(dot + 1));
}

/** One instance within a collection group: its path and the leaf paths it owns. */
interface InstanceGroup {
  readonly path: string;
  readonly key: string;
  readonly label: string;
  readonly paths: readonly FieldPath[];
}

/** One resource group: singletons have one unnamed instance; collections may have many. */
interface ResourceGroup {
  readonly name: string | undefined;
  readonly instances: readonly InstanceGroup[];
  readonly isEmpty: boolean;
}

/** Derive resource groups and instances from the leaf paths, never by naming a group. */
function groupFields(
  fields: ReviewFields,
  presentButEmpty: readonly string[] = [],
): readonly ResourceGroup[] {
  const groups = new Map<string | undefined, Map<string, FieldPath[]>>();
  const groupOrder: (string | undefined)[] = [];

  for (const path of Object.keys(fields)) {
    const segments = parseFieldPath(path);
    const groupName = segments[0]?.key;
    // The instance key is the bracketed segment that follows the group, if any.
    const instanceKey = segments[1]?.kind === "instanceKey" ? segments[1].key : undefined;
    // The map key is the bare instance key ("k1") for collections, or "" for singleton groups.
    const mapKey = instanceKey ?? "";

    if (!groups.has(groupName)) {
      groups.set(groupName, new Map());
      groupOrder.push(groupName);
    }
    const instances = groups.get(groupName)!;
    if (!instances.has(mapKey)) {
      instances.set(mapKey, []);
    }
    instances.get(mapKey)!.push(path);
  }

  const result: ResourceGroup[] = groupOrder.map((name) => {
    const instances = groups.get(name)!;
    const entries = [...instances.entries()];
    const hasUnnamedSingleton = entries.length === 1 && entries[0]![0] === "";
    if (hasUnnamedSingleton) {
      return {
        name,
        instances: [{ path: name ?? "", key: "", label: "", paths: entries[0]![1] }],
        isEmpty: false,
      };
    }
    return {
      name,
      instances: entries
        .filter(([key]) => key !== "")
        .map(([key, paths], index) => ({
          path: `${name}[${key}]`,
          key,
          label: `${humanize(name ?? "")} ${index + 1}`,
          paths,
        })),
      isEmpty: false,
    };
  });

  for (const groupName of presentButEmpty) {
    if (!groups.has(groupName)) {
      result.push({ name: groupName, instances: [], isEmpty: true });
    }
  }

  return result;
}

export function ReviewPanel() {
  const { items: parked, loading, error } = useSessions({ status: "awaiting-review" });
  const onDeviceExtractor = useSyncExternalStore(
    subscribeToOnDeviceExtractor,
    getOnDeviceExtractorState,
  );

  // The panel that renders extraction state also owns the on-device extractor's
  // arming control and the connectivity invalidation wire. Both are one-shot:
  // StrictMode's double mount is harmless because the store is idempotent and the
  // composite invalidation is a no-op subscription.
  useEffect(() => {
    startOnDeviceExtractor();
    if (extractorComposite !== undefined) {
      wireExtractorConnectivity(extractorComposite, getConnectivity());
    }
  }, []);

  return (
    <section style={panel}>
      <h2>4 · Review extracted fields</h2>
      <p style={muted}>
        The <code style={monospace}>extracting</code> step turns each transcript into structured
        fields, with the verbatim quote that justifies every value, then parks the item here rather
        than writing it straight through. Drain the queue above (<em>sync now</em>, or{" "}
        <em>Transcribe</em>) and the fields wait below for a decision — this panel is where they
        move forward, to <code style={monospace}>writing</code>, or are dropped.
      </p>

      <OnDeviceExtractorControl state={onDeviceExtractor} />
      <ExtractorBanner />
      <MeasurementCaveat />

      {error !== undefined && <p style={errorBox}>{error.message}</p>}

      {loading ? (
        <p style={muted}>reading the outbox…</p>
      ) : parked.length === 0 ? (
        <p data-testid="review-empty" style={muted}>
          Nothing waiting for review — record something, then drain the queue so an item reaches the{" "}
          <code style={monospace}>awaiting-review</code> step.
        </p>
      ) : (
        <ol style={{ listStyle: "none", margin: "1rem 0 0", padding: 0 }}>
          {parked.map((session) => (
            <ReviewCard key={session.id} session={session} />
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
          Extraction: live ({extractorStatus.strategy}) —{" "}
          <code style={monospace}>{extractorStatus.model}</code> via{" "}
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

/**
 * The arming affordance for on-device extraction.
 *
 * This is a real button, not an effect: Chrome throws `NotAllowedError` from
 * `create()` when the model is downloadable and there is no user gesture
 * (spec §10.4). The copy says the download is Chrome-managed, its size is
 * unknown, and the wait is minutes — the Prompt API reports only a 0..1 fraction.
 */
function OnDeviceExtractorControl({ state }: { state: OnDeviceExtractorState }) {
  switch (state.phase) {
    case "checking":
      return <p style={muted}>Checking whether on-device extraction is available…</p>;

    case "unsupported":
      return (
        <p style={muted}>
          On-device extraction is unavailable: {state.message ?? "unsupported platform"}.
        </p>
      );

    case "needs-download":
      return (
        <div>
          <p style={{ margin: "0 0 0.6rem" }}>
            <strong>On-device extraction is available but not downloaded.</strong> The download is
            Chrome-managed and its size is unknown; it takes about 5 minutes on a fast connection.
            Nothing is fetched until you press the button.
          </p>
          <button type="button" style={button} onClick={() => primeOnDeviceExtractor()}>
            Arm this device for offline extraction
          </button>
        </div>
      );

    case "downloading":
      return <OnDeviceExtractorDownloadProgress state={state} />;

    case "ready":
      return (
        <p style={muted}>
          On-device extraction is armed and ready for offline use. A card drafted by the on-device
          model will be marked below.
        </p>
      );

    case "error":
      return (
        <div>
          <p style={errorBox}>
            On-device extraction arming failed: {state.message ?? "unknown error"}.
          </p>
          <button
            type="button"
            style={{ ...button, marginTop: "0.5rem" }}
            onClick={() => primeOnDeviceExtractor()}
          >
            try again
          </button>
        </div>
      );
  }
}

function OnDeviceExtractorDownloadProgress({ state }: { state: OnDeviceExtractorState }) {
  const fraction = state.progress?.fraction ?? 0;
  const percent = Math.round(fraction * 100);

  return (
    <div>
      <p style={{ margin: "0 0 0.5rem" }}>Downloading on-device extraction model… {percent}%</p>
      <div
        style={{ background: "#eaeef2", borderRadius: 7, height: 14, overflow: "hidden" }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            background: "#1f883d",
            height: "100%",
            transition: "width 120ms linear",
            width: `${String(percent)}%`,
          }}
        />
      </div>
      <p style={{ ...muted, margin: "0.4rem 0 0" }}>
        This may take several minutes. Leave this tab open.
      </p>
    </div>
  );
}

function ReviewCard({ session }: { session: SessionItem }) {
  const {
    ready,
    fields,
    decisionOf,
    accept,
    edit,
    reject,
    untouched,
    errors,
    presentButEmpty,
    addInstance,
    removeInstance,
    submit,
    discard,
    submitting,
    error,
  } = useReview(session, {
    valuesSchema: snuggValuesSchema,
    requiredOnCreate: snuggProAdapter.requiredOnCreate,
  });

  const untouchedSet = useMemo(() => new Set(untouched), [untouched]);

  const blockedPaths = useMemo(
    () => untouched.filter((path) => fields?.[path]?.isGrounded === false),
    [fields, untouched],
  );
  const blocked = blockedPaths.length > 0;

  const groups = useMemo(
    () => (fields === undefined ? [] : groupFields(fields, presentButEmpty)),
    [fields, presentButEmpty],
  );

  // Re-derived from the envelope itself, not from what a flatten walk happened to
  // find — see the `@file` note. `stated` / `silent` are purely informational: the
  // gate above is what forces a decision, this is only what orients a reviewer
  // opening a 51-leaf card.
  const stated =
    fields === undefined
      ? 0
      : Object.values(fields).filter((f) => f.extracted.value !== null).length;
  const silent =
    fields === undefined
      ? 0
      : Object.values(fields).filter(
          (f) => f.extracted.value === null && f.extracted.sourceSpan === null,
        ).length;

  const handleSubmit = () => {
    submit().catch(() => {
      // Refusal is already captured in `error`/`errors` above; a card that lets
      // this reject unhandled is a console error on top of a card that looks stuck.
    });
  };

  const handleDiscard = () => {
    discard().catch(() => {
      // Same as `handleSubmit` — `error` already shows it.
    });
  };

  if (!ready || fields === undefined) {
    return (
      <li
        data-testid="review-card"
        style={{ borderTop: "1px solid #eaeef2", padding: "0.85rem 0" }}
      >
        <p style={muted}>
          <strong style={monospace}>#{session.id.slice(0, 8)}</strong> is not ready for review — it
          has no transcript, no extraction, or both.
        </p>
      </li>
    );
  }

  return (
    <li data-testid="review-card" style={{ borderTop: "1px solid #eaeef2", padding: "0.85rem 0" }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
        <strong style={monospace}>#{session.id.slice(0, 8)}</strong>
        <span style={statusBadge(session.status)}>{session.status}</span>
        {/* Compared against the exported constant, not a copy of its value: the
            engine id is written by the extractor and read here, and a literal in
            one of those two places drifts silently — the badge would just stop
            appearing, which looks like "no on-device extractions happened". */}
        {session.extractedBy === ONDEVICE_CHAT_ENGINE && (
          <span style={betaBadge}>beta — on-device extraction</span>
        )}
        <span style={muted}>
          {stated} stated · {silent} silent · {Object.keys(fields).length} leaves total
        </span>
      </div>

      {groups.map((group) => (
        <ResourceGroup
          key={group.name ?? ""}
          group={group}
          fields={fields}
          decisionOf={decisionOf}
          untouchedSet={untouchedSet}
          errors={errors}
          onAccept={accept}
          onEdit={edit}
          onReject={reject}
          onAddInstance={addInstance}
          onRemoveInstance={removeInstance}
        />
      ))}

      {error !== undefined && <p style={errorBox}>{error.message}</p>}

      {blocked && (
        <p style={{ ...muted, margin: "0.75rem 0 0" }} data-testid="review-blocked">
          {blockedPaths.length} field{blockedPaths.length === 1 ? "" : "s"} still need your review
          before this can be submitted — their quote is not found in this transcript, or nothing was
          extracted for them, and nobody has accepted, edited or rejected them yet.
        </p>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        <button
          type="button"
          style={button}
          onClick={handleSubmit}
          disabled={blocked || submitting}
        >
          {submitting ? "submitting…" : "Accept all and queue"}
        </button>
        <button type="button" style={button} onClick={handleDiscard} disabled={submitting}>
          Discard
        </button>
      </div>
    </li>
  );
}

function ResourceGroup({
  group,
  fields,
  decisionOf,
  untouchedSet,
  errors,
  onAccept,
  onEdit,
  onReject,
  onAddInstance,
  onRemoveInstance,
}: {
  readonly group: ResourceGroup;
  readonly fields: ReviewFields;
  readonly decisionOf: (path: FieldPath) => FieldDecision | undefined;
  readonly untouchedSet: ReadonlySet<FieldPath>;
  readonly errors: Readonly<Record<FieldPath, string>>;
  readonly onAccept: (path: FieldPath) => void;
  readonly onEdit: (path: FieldPath, value: unknown) => void;
  readonly onReject: (path: FieldPath) => void;
  readonly onAddInstance: (group: string) => void;
  readonly onRemoveInstance: (instancePath: string) => void;
}) {
  const { name, instances, isEmpty } = group;
  return (
    <div style={{ marginTop: "0.75rem" }} data-testid={`review-group-${name ?? "unnamed"}`}>
      {name !== undefined && (
        <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.35rem" }}>{humanize(name)}</h3>
      )}
      {isEmpty ? (
        <div>
          <p style={muted}>none described</p>
          <button
            type="button"
            style={button}
            data-testid={`add-instance-${name}`}
            onClick={() => name !== undefined && onAddInstance(name)}
          >
            Add one
          </button>
        </div>
      ) : (
        <>
          {instances.map((instance) => (
            <InstanceSection
              key={instance.path}
              instance={instance}
              fields={fields}
              decisionOf={decisionOf}
              untouchedSet={untouchedSet}
              errors={errors}
              onAccept={onAccept}
              onEdit={onEdit}
              onReject={onReject}
              onRemoveInstance={onRemoveInstance}
            />
          ))}
          {name !== undefined && (
            <button
              type="button"
              style={button}
              data-testid={`add-instance-${name}`}
              onClick={() => onAddInstance(name)}
            >
              Add another
            </button>
          )}
        </>
      )}
    </div>
  );
}

function InstanceSection({
  instance,
  fields,
  decisionOf,
  untouchedSet,
  errors,
  onAccept,
  onEdit,
  onReject,
  onRemoveInstance,
}: {
  readonly instance: InstanceGroup;
  readonly fields: ReviewFields;
  readonly decisionOf: (path: FieldPath) => FieldDecision | undefined;
  readonly untouchedSet: ReadonlySet<FieldPath>;
  readonly errors: Readonly<Record<FieldPath, string>>;
  readonly onAccept: (path: FieldPath) => void;
  readonly onEdit: (path: FieldPath, value: unknown) => void;
  readonly onReject: (path: FieldPath) => void;
  readonly onRemoveInstance: (instancePath: string) => void;
}) {
  return (
    <div style={{ margin: "0.5rem 0 0.75rem" }} data-testid={`review-instance-${instance.path}`}>
      <div
        style={{ alignItems: "center", display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}
      >
        <h4 style={{ fontSize: "0.85rem", margin: 0 }}>{instance.label}</h4>
        {instance.key !== "" && (
          <button
            type="button"
            style={{ ...button, fontSize: "0.75rem", padding: "0.1rem 0.4rem" }}
            data-testid={`remove-instance-${instance.path}`}
            onClick={() => onRemoveInstance(instance.path)}
          >
            Remove
          </button>
        )}
      </div>
      <dl style={{ margin: 0 }}>
        {instance.paths.map((path) => (
          <FieldRow
            key={path}
            path={path}
            label={leafLabel(path)}
            field={fields[path]!}
            decision={decisionOf(path)}
            isUntouched={untouchedSet.has(path)}
            errorMessage={errors[path]}
            onAccept={onAccept}
            onEdit={onEdit}
            onReject={onReject}
          />
        ))}
      </dl>
    </div>
  );
}

function FieldRow({
  path,
  label,
  field,
  decision,
  isUntouched,
  errorMessage,
  onAccept,
  onEdit,
  onReject,
}: {
  readonly path: FieldPath;
  /** Display label, already stripped of the group/instance prefix. */
  readonly label: string;
  readonly field: ReviewField;
  readonly decision: FieldDecision | undefined;
  /** From `useReview`'s own `untouched`, not from `decision` — see the note below. */
  readonly isUntouched: boolean;
  readonly errorMessage: string | undefined;
  readonly onAccept: (path: FieldPath) => void;
  readonly onEdit: (path: FieldPath, value: unknown) => void;
  readonly onReject: (path: FieldPath) => void;
}) {
  const { value, sourceSpan } = field.extracted;
  const status = decision?.status ?? "accepted";
  const currentValue =
    decision !== undefined && decision.status === "edited" ? decision.value : value;
  // A row needs the reviewer's eyes precisely when it is both untouched AND
  // ungrounded — the property the submit gate itself enforces.
  const needsReview = isUntouched && !field.isGrounded;

  return (
    <div
      style={{
        borderTop: "1px solid #f6f8fa",
        padding: "0.5rem 0",
        ...(needsReview ? { background: "#fff8c5" } : {}),
      }}
      // Path-specific rather than a shared "review-field" testid: with 51
      // leaves on one card, a test driving one specific row needs to reach it
      // directly rather than filtering 51 matches by hand.
      data-testid={`review-field-${path}`}
      data-path={path}
    >
      <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <span style={{ fontWeight: 600 }}>
          {label}
          {field.required && <span title="required by the host tool"> *</span>}
        </span>
        <DecisionBadge status={status} />
        {sourceSpan !== null && (
          <span
            style={{ color: field.isGrounded ? "#1f883d" : "#bf8700", fontSize: "0.8rem" }}
            title={
              field.isGrounded
                ? "verbatim substring of this recording's transcript"
                : "not found in this recording's transcript"
            }
          >
            {field.isGrounded ? "✓ said aloud" : "⚠ not in this transcript"} <q>{sourceSpan}</q>
          </span>
        )}
        {sourceSpan === null && value === null && (
          <span style={muted}>not stated in this recording</span>
        )}
      </div>

      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.4rem",
          marginTop: "0.3rem",
        }}
      >
        {/* Keyed on `status`: the number/text editors below hold their value in an
          UNCONTROLLED input (so typing is never fought by a re-render), which
          means clicking Accept/Reject after an edit would otherwise leave the
          typed characters on screen even though the decision reverted — a
          reviewer trusting what they see would be shown a stale value. Changing
          `status` (which Accept/Reject do, but a same-status keystroke does not)
          remounts the input with a fresh `defaultValue` off the reverted decision. */}
        <FieldEditor
          key={status}
          path={path}
          label={label}
          schema={field.schema}
          value={currentValue}
          onEdit={onEdit}
        />
        <button
          type="button"
          style={button}
          data-testid="accept-field"
          onClick={() => onAccept(path)}
          // NOT simply `status === "accepted"`: `decisionOf` defaults an
          // untouched leaf's DISPLAYED status to "accepted" (so submit()
          // treats leaving it alone as acceptance), which means that
          // comparison alone is true from the very first render — disabling
          // the one button a reviewer needs to press to actually touch an
          // untouched, ungrounded leaf, and so a real click could never
          // release the submit gate for it. Disabling requires an EXPLICIT
          // "accepted" decision, which `isUntouched` is what rules out.
          disabled={!isUntouched && status === "accepted"}
        >
          Accept
        </button>
        <button
          type="button"
          style={button}
          data-testid="reject-field"
          onClick={() => onReject(path)}
          disabled={status === "rejected"}
        >
          Reject
        </button>
      </div>

      {errorMessage !== undefined && (
        <p style={{ ...errorBox, margin: "0.3rem 0 0" }}>{errorMessage}</p>
      )}
    </div>
  );
}

function DecisionBadge({ status }: { status: "accepted" | "edited" | "rejected" }) {
  const label = status === "accepted" ? "accepted" : status === "edited" ? "edited" : "rejected";
  return (
    <span
      style={{
        background: status === "rejected" ? "#d1242f" : status === "edited" ? "#8250df" : "#57606a",
        borderRadius: 999,
        color: "#fff",
        fontSize: "0.7rem",
        padding: "0.05rem 0.5rem",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

/**
 * Picks an editor from the leaf's own schema — never from its name.
 *
 * A `z.enum` gets a `<select>` built from the schema's own members; a
 * `z.number()` gets a numeric input; a `z.boolean()` gets a yes/no `<select>`.
 * Everything else — `z.string()`, and any shape this file does not specifically
 * recognise — gets a plain text box. Nothing here is a Snugg Pro fact: an
 * unrecognised kind still gets a working, if generic, editor rather than being
 * refused, because a review card must render *something* for every leaf a future
 * adapter declares.
 */
function FieldEditor({
  path,
  label,
  schema,
  value,
  onEdit,
}: {
  readonly path: FieldPath;
  readonly label: string;
  readonly schema: z.ZodType<unknown>;
  readonly value: unknown;
  readonly onEdit: (path: FieldPath, value: unknown) => void;
}) {
  // `stripOptionalNullable` is `@azx/ribo-core`'s own walk — the same one
  // `enveloped()` and `buildReviewRequest` use to decide what a leaf's real
  // kind is — so this file has no zod-wrapper logic of its own to disagree
  // with core about.
  const kind = stripOptionalNullable(schema);

  if (kind instanceof z.ZodEnum) {
    // Every enum this repo declares is string-valued (`schema.ts`'s file header:
    // "the enum members are the wire strings, verbatim"), but `.options`'s type is
    // `Array<string | number>` in general — filtered rather than cast, so a future
    // numeric enum renders no options instead of a cast lying about their type.
    const options = kind.options.filter((option): option is string => typeof option === "string");
    const current = typeof value === "string" ? value : "";
    return (
      <select
        aria-label={label}
        data-testid="field-editor"
        value={current}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          onEdit(path, event.target.value === "" ? null : event.target.value);
        }}
      >
        <option value="">— none —</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (kind instanceof z.ZodNumber) {
    const current = typeof value === "number" ? String(value) : "";
    return (
      <input
        aria-label={label}
        data-testid="field-editor"
        type="number"
        defaultValue={current}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const raw = event.target.value;
          onEdit(path, raw === "" ? null : Number(raw));
        }}
      />
    );
  }

  if (kind instanceof z.ZodBoolean) {
    const current = value === true ? "true" : value === false ? "false" : "";
    return (
      <select
        aria-label={label}
        data-testid="field-editor"
        value={current}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          const raw = event.target.value;
          onEdit(path, raw === "" ? null : raw === "true");
        }}
      >
        <option value="">— none —</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  // `z.string()` and `z.literal()` — the common remaining leaf kinds in this
  // schema — get a plain text box whose edit is the raw string, verbatim. This
  // must NOT run the JSON leaf's fallback below: `JSON.parse("2011")` returns the
  // *number* `2011`, which would silently turn a typed model number like
  // `hvacHeatingSystemModel` from a string into a number underneath the reviewer.
  //
  // DELIBERATE CHOICE, not an oversight: `z.string().nullable()` admits both
  // `""` and `null` as distinct legal values, but this editor cannot produce
  // `""` at all — clearing the box always sends `null`. A blank text input
  // already reads as "nothing here" to a reviewer; asking them to distinguish
  // "I typed nothing on purpose" from "delete this value" for a free-text
  // leaf (Snugg Pro's two string leaves are a model number and a duct
  // location — neither has a use for an explicit empty string that a `null`
  // does not already cover) is a second control on every string row for a
  // distinction with no product payoff. If a future leaf's write target ever
  // treats `""` and `null` differently at the API, that concrete case is the
  // trigger to add the distinction back — not a preemptive one here.
  if (kind instanceof z.ZodString || kind instanceof z.ZodLiteral) {
    const current =
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? ""
          : String(value);
    return (
      <input
        aria-label={label}
        data-testid="field-editor"
        type="text"
        defaultValue={current}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const raw = event.target.value;
          onEdit(path, raw === "" ? null : raw);
        }}
      />
    );
  }

  // Any other, unrecognised leaf kind (an array, a record, a union — none of
  // which this adapter declares today): a text box that round-trips through JSON,
  // best-effort. An edit that does not parse as JSON is sent through as the raw
  // string instead, and `errors[path]` is what tells the reviewer the leaf's own
  // schema rejected it — this file does not need to know why.
  const current =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  return (
    <input
      aria-label={label}
      data-testid="field-editor"
      type="text"
      defaultValue={current}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const raw = event.target.value;
        if (raw === "") {
          onEdit(path, null);
          return;
        }
        try {
          onEdit(path, JSON.parse(raw));
        } catch {
          onEdit(path, raw);
        }
      }}
    />
  );
}
