import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactElement,
} from "react";
import { z } from "zod";
import { stripOptionalNullable } from "@azx/ribo-core";
import type {
  FieldDecision,
  FieldPath,
  ReviewField,
  ReviewFields,
  ReviewNode,
  ReviewPlan,
  ReviewSectionNode,
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
 * `useCaptures({ status: "awaiting-review" })` replaces the old "every item
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
 * the schema, not here. This is what lets the field set grow without a UI edit.
 *
 * ## Grouping is generic and instance-aware
 *
 * A card's groups and instances come from `useReview`'s `tree` — core's own schema walk,
 * handed over in the shape it saw rather than flattened into path text this file would
 * have to parse back. `cardEntries` below is a rename onto this panel's rendering types,
 * not a reconstruction. Collection groups render each instance as a subsection with an
 * add/remove affordance; a group whose state is `empty` renders with an add affordance so
 * the auditor can still notice it was missed, while an `absent` one renders nothing —
 * "there are none of these" and "never mentioned" are different claims.
 *
 * ## Sections are the plan's outline, rendered from the tree
 *
 * With a `reviewPlan` the tree carries section nodes, and the card renders each as a heading
 * one level under the heading it sits inside, with its label verbatim. Fields keep the
 * tree's order; a patch subtree inside a section renders as plain rows, as nested groups do
 * elsewhere. A section has no path or key, so tests find it by `data-testid="review-section"`.
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

/** One instance within a collection group: its path, its label, and the tree children it owns. */
interface InstanceGroup {
  readonly path: string;
  readonly key: string;
  readonly label: string;
  readonly children: readonly ReviewNode[];
}

/** One resource group: singletons have one unnamed instance; collections may have many. */
interface ResourceGroup {
  readonly name: string | undefined;
  /**
   * Whether the group is a collection — the only kind that can gain an
   * instance. The add affordances exist for it alone: the hook refuses
   * `addInstance` for any other group, so a button offered there is a dead
   * control that throws on every click.
   */
  readonly isCollection: boolean;
  readonly instances: readonly InstanceGroup[];
  readonly isEmpty: boolean;
  readonly emptyQuote: string | null;
}

/**
 * What the card renders below its header, in tree order: a resource group (a
 * schema group with its instances), or a plan-laid-out top-level section — a
 * nest's new group, which is no group of the schema's at all.
 */
type CardEntry =
  | { readonly kind: "group"; readonly group: ResourceGroup }
  | { readonly kind: "section"; readonly label: string; readonly children: readonly ReviewNode[] };

/** Every leaf path under a node, in the order the tree presents them. */
function leafPathsOf(nodes: readonly ReviewNode[]): FieldPath[] {
  return nodes.flatMap((node) => {
    if (node.kind === "leaf") return [node.path];
    if (node.kind === "object") return leafPathsOf(node.children);
    if (node.kind === "section") return leafPathsOf(node.children);
    return node.instances.flatMap((instance) => leafPathsOf(instance.children));
  });
}

/**
 * Map core's review tree onto this panel's rendering shape.
 *
 * This used to reconstruct the group/instance structure from the leaf paths with
 * `parseFieldPath` — roughly sixty lines of grouping, ordering and empty-group patching,
 * which core threw away and every host wrote again. The tree is the same walk's own output,
 * so this is now a rename rather than a derivation.
 *
 * An `absent` collection is skipped: the group was never mentioned, so there is nothing to
 * show and no add affordance to offer. `empty` means "there are none of these", which is a
 * claim worth rendering.
 */
function cardEntries(tree: readonly ReviewNode[]): readonly CardEntry[] {
  const result: CardEntry[] = [];
  for (const node of tree) {
    if (node.kind === "leaf") {
      result.push({
        kind: "group",
        group: {
          name: node.key,
          isCollection: false,
          instances: [{ path: node.path, key: "", label: "", children: [node] }],
          isEmpty: false,
          emptyQuote: null,
        },
      });
      continue;
    }
    if (node.kind === "object") {
      result.push({
        kind: "group",
        group: {
          name: node.key,
          isCollection: false,
          instances: [{ path: node.path, key: "", label: "", children: node.children }],
          isEmpty: false,
          emptyQuote: null,
        },
      });
      continue;
    }
    // A top-level section is a nest's new group: it renders as its own entry,
    // not as a resource group — it carries no key and holds no instances.
    if (node.kind === "section") {
      result.push({ kind: "section", label: node.label, children: node.children });
      continue;
    }
    if (node.state === "absent") continue;
    result.push({
      kind: "group",
      group: {
        name: node.key,
        isCollection: true,
        instances: node.instances.map((instance, index) => ({
          path: instance.path,
          key: instance.key,
          label: `${humanize(node.key)} ${index + 1}`,
          children: instance.children,
        })),
        isEmpty: node.state === "empty" || node.state === "statedEmpty",
        emptyQuote: node.emptyQuote,
      },
    });
  }
  return result;
}

export function ReviewPanel({
  reviewPlan,
}: {
  /** The plan the card's tree is laid out by; without one, no sections. */
  readonly reviewPlan?: ReviewPlan;
}) {
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
        <p style={muted}>reading the storage…</p>
      ) : parked.length === 0 ? (
        <p data-testid="review-empty" style={muted}>
          Nothing waiting for review — record something, then drain the queue so an item reaches the{" "}
          <code style={monospace}>awaiting-review</code> step.
        </p>
      ) : (
        <ol style={{ listStyle: "none", margin: "1rem 0 0", padding: 0 }}>
          {parked.map((session) => (
            <ReviewCard key={session.id} session={session} reviewPlan={reviewPlan} />
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

function ReviewCard({
  session,
  reviewPlan,
}: {
  readonly session: SessionItem;
  /** The plan the card's tree is laid out by; without one, no sections. */
  readonly reviewPlan?: ReviewPlan;
}) {
  const {
    ready,
    fields,
    decisionOf,
    accept,
    edit,
    reject,
    untouched,
    errors,
    tree,
    addInstance,
    removeInstance,
    submit,
    discard,
    submitting,
    error,
  } = useReview(session, {
    valuesSchema: snuggValuesSchema,
    requiredOnCreate: snuggProAdapter.requiredOnCreate,
    reviewPlan,
  });

  const untouchedSet = useMemo(() => new Set(untouched), [untouched]);

  const blockedPaths = useMemo(
    () => untouched.filter((path) => fields?.[path]?.isGrounded === false),
    [fields, untouched],
  );
  const blocked = blockedPaths.length > 0;

  const entries = useMemo(() => (tree === undefined ? [] : cardEntries(tree)), [tree]);

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

      {entries.map((entry) =>
        entry.kind === "group" ? (
          <ResourceGroup
            key={`group:${entry.group.name ?? ""}`}
            group={entry.group}
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
        ) : (
          <PlanSection
            key={`section:${entry.label}`}
            label={entry.label}
            nodes={entry.children}
            level={3}
            fields={fields}
            decisionOf={decisionOf}
            untouchedSet={untouchedSet}
            errors={errors}
            onAccept={accept}
            onEdit={edit}
            onReject={reject}
          />
        ),
      )}

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
  const { name, instances, isEmpty, emptyQuote, isCollection } = group;
  return (
    <div style={{ marginTop: "0.75rem" }} data-testid={`review-group-${name ?? "unnamed"}`}>
      {name !== undefined && (
        <h3 style={{ fontSize: HEADING_SIZE[3], margin: "0 0 0.35rem" }}>{humanize(name)}</h3>
      )}
      {isEmpty ? (
        <div>
          {emptyQuote !== null ? (
            <>
              <p style={muted}>None in this house.</p>
              <p style={{ ...muted, fontStyle: "italic", margin: "0.2rem 0 0" }}>
                <q>{emptyQuote}</q>
              </p>
            </>
          ) : (
            <p style={muted}>none described</p>
          )}
          {isCollection && (
            <button
              type="button"
              style={button}
              data-testid={`add-instance-${name}`}
              onClick={() => name !== undefined && onAddInstance(name)}
            >
              Add one
            </button>
          )}
        </div>
      ) : (
        <>
          {instances.map((instance) => (
            <InstanceSection
              key={instance.path}
              instance={instance}
              // A section heading nests one level under the heading it appears
              // inside: one deeper than a singleton group's h3, one deeper than a
              // collection instance's h4.
              sectionLevel={instance.key === "" ? 4 : 5}
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
          {isCollection && name !== undefined && (
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
  sectionLevel,
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
  /** The heading level a section directly inside this instance renders at. */
  readonly sectionLevel: number;
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
        <h4 style={{ fontSize: HEADING_SIZE[4], margin: 0 }}>{instance.label}</h4>
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
      <ChildBlocks
        nodes={instance.children}
        level={sectionLevel}
        fields={fields}
        decisionOf={decisionOf}
        untouchedSet={untouchedSet}
        errors={errors}
        onAccept={onAccept}
        onEdit={onEdit}
        onReject={onReject}
      />
    </div>
  );
}

/**
 * The review card's heading type scale, by heading level — one home for every
 * heading the card renders: a group heading is level 3, an instance heading
 * level 4, and a section one level under its container, so a
 * section at group level shares the group heading's size.
 */
const HEADING_SIZE: Readonly<Record<number, string>> = {
  3: "0.9rem",
  4: "0.85rem",
  5: "0.8rem",
  6: "0.75rem",
};

function SectionHeading({
  level,
  label,
}: {
  readonly level: number;
  readonly label: string;
}): ReactElement {
  // Native heading elements end at h6; a plan nested deeper than the decided
  // surface (which tops at h5) still renders a real heading — the deepest there is.
  const depth = Math.min(level, 6);
  const Tag = `h${depth}` as "h3" | "h4" | "h5" | "h6";
  return (
    <Tag
      data-testid="review-section"
      style={{ fontSize: HEADING_SIZE[depth] ?? "0.75rem", margin: "0.5rem 0 0.35rem" }}
    >
      {label}
    </Tag>
  );
}

/**
 * One run of a container's children: the consecutive non-section nodes between
 * two sections (rendered as one flat run of field rows — which is all a no-plan
 * container ever holds), or a section node (its own heading plus its content).
 * Everything a container holds lands in exactly one item, in tree order.
 */
type ContentItem =
  | { readonly kind: "rows"; readonly key: string; readonly nodes: readonly PathedNode[] }
  | { readonly kind: "section"; readonly node: ReviewSectionNode };

/** The node kinds that carry a `path` — every one but a section. */
type PathedNode = Exclude<ReviewNode, ReviewSectionNode>;

function contentItemsOf(nodes: readonly ReviewNode[]): readonly ContentItem[] {
  const items: ContentItem[] = [];
  let batch: PathedNode[] = [];
  const flush = (): void => {
    const [head, ...rest] = batch;
    if (head === undefined) return;
    items.push({ kind: "rows", key: `rows:${head.path}`, nodes: [head, ...rest] });
    batch = [];
  };
  for (const node of nodes) {
    if (node.kind === "section") {
      flush();
      items.push({ kind: "section", node });
    } else {
      batch.push(node);
    }
  }
  flush();
  return items;
}

interface FieldRenderingProps {
  readonly fields: ReviewFields;
  readonly decisionOf: (path: FieldPath) => FieldDecision | undefined;
  readonly untouchedSet: ReadonlySet<FieldPath>;
  readonly errors: Readonly<Record<FieldPath, string>>;
  readonly onAccept: (path: FieldPath) => void;
  readonly onEdit: (path: FieldPath, value: unknown) => void;
  readonly onReject: (path: FieldPath) => void;
}

/**
 * A container's content, in the tree's own order: runs of field rows interleaved
 * with the sections' headings and content. `level` is the heading level for the
 * sections directly in `nodes`; a nested section renders one level deeper.
 *
 * Inside a section the patch's own subtree structure renders flattened — every
 * descendant leaf as a plain field row, no headings of its own — which is how
 * anything nested inside a group or instance renders today.
 */
function ChildBlocks({
  nodes,
  level,
  fields,
  decisionOf,
  untouchedSet,
  errors,
  onAccept,
  onEdit,
  onReject,
}: {
  readonly nodes: readonly ReviewNode[];
  readonly level: number;
} & FieldRenderingProps): ReactElement {
  return (
    <>
      {contentItemsOf(nodes).map((item) =>
        item.kind === "rows" ? (
          <dl key={item.key} style={{ margin: 0 }}>
            {leafPathsOf(item.nodes).map((path) => (
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
        ) : (
          <PlanSection
            key={`section:${item.node.label}`}
            label={item.node.label}
            nodes={item.node.children}
            level={level}
            fields={fields}
            decisionOf={decisionOf}
            untouchedSet={untouchedSet}
            errors={errors}
            onAccept={onAccept}
            onEdit={onEdit}
            onReject={onReject}
          />
        ),
      )}
    </>
  );
}

/** A plan-laid-out section: its label verbatim as a heading, its content beneath. */
function PlanSection({
  label,
  nodes,
  level,
  fields,
  decisionOf,
  untouchedSet,
  errors,
  onAccept,
  onEdit,
  onReject,
}: {
  readonly label: string;
  readonly nodes: readonly ReviewNode[];
  readonly level: number;
} & FieldRenderingProps): ReactElement {
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <SectionHeading level={level} label={label} />
      <ChildBlocks
        nodes={nodes}
        level={level + 1}
        fields={fields}
        decisionOf={decisionOf}
        untouchedSet={untouchedSet}
        errors={errors}
        onAccept={onAccept}
        onEdit={onEdit}
        onReject={onReject}
      />
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
    // A ZodString leaf is a string or null; a ZodLiteral leaf may also hold a number
    // or boolean literal. Anything else cannot round-trip through a text box, so it
    // is serialised rather than object-stringified.
    const current =
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? ""
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : (JSON.stringify(value) ?? "");
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
