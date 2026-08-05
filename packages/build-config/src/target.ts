/**
 * @file Translates browserslist output into the tokens oxc accepts.
 *
 * tsdown reads no browserslist config of its own — verified by inspection of
 * `resolveTarget` in tsdown 0.22.14, whose only inference path is `engines.node`
 * — so the query result has to be translated here. Called only by
 * `scripts/refresh-target.mjs`; builds read the generated tokens and never run
 * this. See docs/superpowers/specs/2026-08-04-r1-package-build-configs-design.md §3.
 */

/**
 * browserslist family name -> oxc target name.
 *
 * `and_chr` and `and_ff` are deliberately absent, and that omission is
 * load-bearing rather than an oversight — see the test that covers it. Neither
 * has an oxc token, and browserslist reports Chrome and Firefox for Android as
 * current-only, so folding them into a per-family minimum raises the floor to
 * the newest shipping version. Desktop Chrome and Firefox bind the same syntax,
 * so dropping them costs nothing.
 */
const OXC_FAMILY: Readonly<Record<string, string>> = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  safari: "safari",
  ios_saf: "ios",
};

/** Segment-wise numeric compare. Negative when `a` is the lower version. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Reduces raw browserslist output (`["chrome 121", "safari 18.5-18.7", …]`) to
 * one sorted oxc token per family, at that family's lowest supported version.
 */
export function toOxcTargets(browsers: readonly string[]): string[] {
  const lowest = new Map<string, string>();

  for (const entry of browsers) {
    // Assumes browserslist's single-space `"family version"` pairs; a tab or
    // double space would mis-split, but browserslist's output format is stable.
    const [family, range] = entry.split(" ");
    if (family === undefined || range === undefined) continue;

    const token = OXC_FAMILY[family];
    if (token === undefined) continue;

    // browserslist collapses adjacent releases into "18.5-18.7"; the low end is
    // the floor we must support.
    const version = range.split("-")[0];
    if (version === undefined) continue;

    const incumbent = lowest.get(token);
    if (incumbent === undefined || compareVersions(version, incumbent) < 0) {
      lowest.set(token, version);
    }
  }

  // Sorted so the generated file is byte-stable regardless of browserslist's
  // output ordering — otherwise a reordering upstream looks like a real diff.
  return [...lowest].map(([token, version]) => `${token}${version}`).sort();
}
