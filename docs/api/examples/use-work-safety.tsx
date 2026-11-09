/**
 * The type-checked example behind docs/api/use-work-safety.html.
 *
 * Calling a hook needs React's renderer, so this file is never executed. It
 * is type-checked by the examples tsconfig (see docs/api/index.md), so the
 * shapes shown on the page are real. Runtime behaviour is covered by
 * packages/ribo-ui-react/src/use-work-safety.browser.test.tsx and the e2e
 * suite.
 */

import { useWorkSafety } from "@azx/ribo-ui-react";

// #region usage
// Hooks run inside a component, never at module scope. The verdict is
// withheld — undefined — while loading or after a storage read error. It is
// never defaulted: an unreadable storage looks exactly like an empty one, and
// "empty" classifies as safe.
export function WorkSafetyBanner() {
  const { safety, work, loading, error } = useWorkSafety();
  if (safety === undefined) {
    console.log("no honest verdict yet:", loading ? "loading" : "error", error);
  } else {
    console.log(safety.level, safety.reason, work);
  }
  return null;
}
// #endregion usage
