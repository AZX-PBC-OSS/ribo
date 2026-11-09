/**
 * The type-checked example behind docs/api/use-connectivity.html.
 *
 * Calling a hook needs React's renderer, so this file is never executed. It
 * is type-checked by the examples tsconfig (see docs/api/index.md), so the
 * shapes shown on the page are real. Runtime behaviour is covered by
 * packages/ribo-ui-react/src/use-connectivity.browser.test.tsx.
 */

import { useConnectivity } from "@azx/ribo-ui-react";

// #region usage
// Hooks run inside a component, never at module scope. State only: lifecycle
// stays the host's. A model whose start() has never run sits at its initial
// state and reports no transitions — the honest result, not a hook quietly
// starting something it does not own.
export function ConnectivityBadge() {
  const { status } = useConnectivity();
  console.log(status);
  return null;
}
// #endregion usage
