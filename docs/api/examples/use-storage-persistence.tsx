/**
 * The type-checked example behind docs/api/use-storage-persistence.html.
 *
 * Calling a hook needs React's renderer and the hook wraps `navigator.storage`
 * — browser globals the node runner does not have — so this file is never
 * executed. It is type-checked by the examples tsconfig (see
 * docs/api/index.md), so the shapes shown on the page are real. Runtime
 * behaviour is covered by
 * packages/ribo-ui-react/src/use-storage-persistence.browser.test.tsx.
 */

import { useStoragePersistence } from "@azx/ribo-ui-react";

// #region usage
// Hooks run inside a component, never at module scope. One module-level store
// per origin: every caller sees the same grant, so a request() from a
// settings panel is visible to useWorkSafety immediately.
export function PersistencePanel() {
  const { persistence, estimate, request, refresh } = useStoragePersistence();
  console.log(persistence, estimate);
  refresh();

  // Asking is a separate verb. "denied" means an actual refused request —
  // never "not yet asked", which reads as "unknown" until persist() has
  // answered.
  void (async () => {
    const after = await request();
    console.log(after);
  })();
  return null;
}
// #endregion usage
