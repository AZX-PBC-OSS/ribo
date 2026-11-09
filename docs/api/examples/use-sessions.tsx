/**
 * The type-checked example behind docs/api/use-sessions.html.
 *
 * Calling a hook needs React's renderer, so this file is never executed. It
 * is type-checked by the examples tsconfig (see docs/api/index.md), so the
 * shapes shown on the page are real. Runtime behaviour is covered by
 * packages/ribo-ui-react/src/use-sessions.browser.test.tsx and the e2e suite.
 */

import { useSessions } from "@azx/ribo-ui-react";

// #region usage
// Hooks run inside a component, never at module scope. The session-collection
// mirror of useCaptures: same by-value query comparison, same load-bearing
// `loading`, same `error` state instead of a thrown subscription failure.
export function SessionList() {
  const { items, loading, error } = useSessions({ status: "open" });
  console.log(items.length, loading, error);
  return null;
}
// #endregion usage
