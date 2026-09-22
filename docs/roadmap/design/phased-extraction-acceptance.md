# The phased-extraction acceptance gate — how to run it

The phased-extraction program's one outstanding item is its acceptance gate. It is manual, it runs
once after all three ports rather than per port, and the person who runs it will probably not be
the person who wrote the plans — so the bar, the harnesses, and the failure path are written down
here instead of living in the heads of the people who are gone. The design is
[phased-extraction-design.md](phased-extraction-design.md); the measurement the bar comes from is
[doc 19](../../implementation/19-ondevice-extraction-strategies.md) §6a.

## The bar is structural, not point accuracy

The gate asks three questions of a run, and no others:

1. **Completions** — every transcript in the corpus completes.
2. **Zero degenerations** — the degenerate whitespace-repetition loop that motivated the
   three-phase shape in the first place never fires.
3. **100% span fidelity** — every cited span is a verbatim quote from the transcript.

Point accuracy — enum hit rates, miss rates, hard hallucination — is **not** the bar. The model is
non-deterministic and the corpus is small, and the repo already records run-to-run variance on
_identical_ code (doc 19 §6a: "45/48 against 44/46 on the same code, measured"). A point-accuracy
comparison across a port therefore cannot distinguish a regression from noise; a structural
property that a working strategy holds and a broken one does not can.

## The two harnesses

**The on-device arm — manual, real Chrome.** `docs/spikes/0005-ondevice-acceptance/` is served as a page and
driven by hand:

```bash
pnpm exec vite --config docs/spikes/0005-ondevice-acceptance/vite.config.ts
```

Open it in **real Chrome** — it refuses to run against Chromium's Prompt API stub, and that refusal
is a check, not a limitation: the stub answers with canned text, so an automated run would produce
numbers that mean nothing. Arm the model first (the page will not download it — the download needs
a gesture and takes minutes), then click a strategy. Results land in
`docs/spikes/0001-extraction-snuggpro/results/ondevice*/`, which is gitignored; its output is not committed.

**The managed arm — needs secrets.** `docs/spikes/0006-managed-three-phase/run.mjs` drives the three-phase
strategy over the corpus through the managed `helixChat` transport (with the per-group strategies
alongside as matched baselines):

```bash
pnpm build:packages   # it imports the packages' built dist/, not workspace source
node docs/spikes/0006-managed-three-phase/run.mjs --strategy three-phase --model <model>
```

Its credentials come from the gitignored `.env.local` at the repo root: `HELIX_DEV_TOKEN` and
`HELIX_BASE_URL` are required (`HELIX_ORIGIN` optionally overrides the default). Results land in
`docs/spikes/0001-extraction-snuggpro/results/managed-<strategy>-<model>/`.

**What to do with the result** — both arms write in the shape the corpus scorer already consumes:

```bash
node docs/spikes/0001-extraction-snuggpro/score.mjs <results-directory>
```

Then read the score against the three structural properties above, not the point figures.

## What a failure means

A structural failure on the on-device arm has one hypothesis to test first. The three-phase port
changed the strategy's run order — **phase-major** (every group's presence, then every group's
span, then every grounded leaf's classify) rather than the monolith's group-major order — and moved
the wrapped-schema fallback into a fourth `classifyWrapped` phase. The design's **§4.7** gives the
reasoning for that ordering (it is what lets a later phase narrow across groups rather than within
one, and it deletes a compounding retry) and does not claim to have measured it — no per-port
measurement was run, which is exactly what this gate is for. If the structural bar fails on the
on-device arm, that ordering change is the first suspect.

The off-ramp is **reverting that one port, not the program.** The engine and the other two ports
stand independently of it: `phasedExtractor`, `gapFillExtractor` and `scopedInstanceExtractor` do
not depend on the three-phase port, and a device that cannot run the ported four-phase shape can
keep the engine.

## Bisecting

The gate runs once after all three ports rather than per port — the accepted trade for not running
a manual gate three times — so a failure does not identify its own cause. The three port commits,
in landing order, are:

1. `704ba90` — `gapFillExtractor` becomes a `phasedExtractor` preset.
2. `80daf5e` — `scopedInstanceExtractor` becomes a `phasedExtractor` preset.
3. `66d0d37` — `threePhaseExtractor` becomes the phased preset, tuned for the device.

Start a bisect from the port that matches the failing arm: the on-device arm exercises the
three-phase port (`66d0d37`), the managed arm runs the same strategy through the managed transport.
A failure that reproduces at the gap-fill port — the first — implicates the engine or that port,
not the two later ones.
