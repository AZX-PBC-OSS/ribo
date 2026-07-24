# 04 — `@azx/ribo-ui` (UI Components)

The rendering layer, kept separate from the headless core so any host can bring its own. Implements `ribo-core`'s `ReviewPresenter`.

## Components

| Component         | Responsibility                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `CaptureControl`  | Mic button: record/stop, live input level, on-device partial transcript as the auditor speaks.          |
| `StatusIndicator` | Queue/sync state — "2 queued", "transcribing…", "synced", error/retry. Reads `Controller` state/events. |
| `ReviewCard`      | The accept/edit surface. Implements `ReviewPresenter.present(draft)`. **Schema-driven.**                |

## Schema-driven review (the reuse payoff)

`ReviewCard` renders from the adapter's zod schema — a labeled, editable field per schema key — and validates on accept. It contains **no Snugg Pro knowledge**, so the same component serves Snugg Pro today and PSE tomorrow; only the adapter's schema differs.

```ts
function ReviewCard<F>({
  draft,
  schema,
  onAccept,
}: {
  draft: F;
  schema: z.ZodObject<any>;
  onAccept: (edited: F) => void;
}) {
  // iterate schema.shape → label + editable input per field;
  // on accept: schema.safeParse(edited) → onAccept, else show field errors
}
```

## Framework

**React + Vite** — our choice, since we own the field app host ([06](06-field-app-helix.md)). This only matters if we ever embed the UI _into_ Snugg Pro's own app (a production-path question, out of scope for the PoC); core + adapter are framework-free regardless.

## Dependency policy: `ribo-ui` stays lean — decided 2026-07-23

**No component library. Specifically, no Mantine in `@azx/ribo-ui`.** CSS Modules compiled to a single `styles.css` remains the plan ([10 §3.1](10-build-and-packaging.md)).

This package is **published into someone else's React app** — Snugg Pro's own codebase is a stated eventual consumer. A component library is not a private implementation detail once it is in a published UI package: it makes the host install Mantine, keep its version in step with ours, and wrap their tree in `MantineProvider` before a single Ribo component renders. That is exactly the imposition the packaging doc already refuses to make for styling frameworks and CSS-in-JS runtimes ([10 §3](10-build-and-packaging.md)), and "integrating your SDK means adopting your UI stack" is one of the ordinary reasons an SDK gets refused at the door.

**Applications may use anything.** The `playground` and the field app ([06](06-field-app-helix.md)) are free to use Mantine, a state library, TanStack Query — whatever makes them good. They are applications, not published libraries, so their dependencies end in their own bundle. The constraint here is narrow and it is the whole point: it is about what we impose on **other people's builds**, not about what we like.

**The option deliberately not taken:** a separate `ribo-ui-mantine` package — a styled implementation of the same components — could be added later if we ever want a batteries-included path for hosts that already run Mantine. That stays available precisely _because_ `ribo-ui` has no component library in it; it would be additive and would not change `ribo-ui` at all. Not planned, just not foreclosed.

## Phase 5 requirement: the level meter owns perceptual scaling

`RecorderState.level` from `ribo-core` is **raw RMS** ([03](03-ribo-core.md)). For ordinary speech that number sits low enough that a bar whose width is `level * 100%` barely leaves the left edge — it looks like a broken meter, not a quiet room. The playground hit this the first time it drew one and applies `Math.sqrt(level)` before rendering (`playground/src/RecordPanel.tsx`).

**Every consumer will rediscover this independently, and each will guess at a different curve.** So the meter in `CaptureControl` owns the mapping: it takes the raw `level` and applies the perceptual scaling itself, rather than leaving each host to find out that the honest value makes a bad bar. The exact curve (`sqrt`, a dB mapping with a floor, a smoothed decay) is a Phase 5 choice to be made against a real microphone; owning the responsibility is the decision here.

Corollary for hosts that do not use `ribo-ui`: this is documented consumer-facing behaviour, not a hidden trick — the meter's scaling should be described where `level` is, so a host drawing its own meter starts from the same place.

## Size & open items

- **Size:** **M**.
- **Open:** exact review UX (all fields on one card vs. progressive); how partial transcript is surfaced during capture. Both are UI polish, not architecture — good candidates for the visual-mockup pass.
