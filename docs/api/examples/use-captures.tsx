/**
 * The type-checked example behind docs/api/use-captures.html.
 *
 * Calling a hook needs React's renderer, so this file is never executed. It
 * is type-checked by the examples tsconfig (see docs/api/index.md), so the
 * shapes shown on the page are real. Runtime behaviour is covered by
 * packages/ribo-ui-react/src/use-captures.browser.test.tsx and the e2e suite.
 */

import { useCaptures } from "@azx/ribo-ui-react";

// #region usage
// Hooks run inside a component, never at module scope. The query is compared
// by value, not identity: a caller writing a fresh object literal every
// render does not tear the storage subscription down.
export function CaptureQueue() {
  const { items, loading, error } = useCaptures({ status: "queued" });
  // `loading` is load-bearing — "reading the storage…" and "nothing in the
  // queue" are different sentences, and conflating them flashes the empty
  // state on every mount.
  console.log(items.length, loading, error);
  return null;
}
// #endregion usage
