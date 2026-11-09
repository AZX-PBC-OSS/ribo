/**
 * The type-checked example behind docs/api/ribo-provider.html.
 *
 * Rendering the provider needs React plus the browser globals the engine
 * instances hold (MediaRecorder, IndexedDB), so this file is never executed.
 * It is type-checked by the examples tsconfig (see docs/api/index.md), so the
 * wiring shown on the page is real. Runtime behaviour is covered by
 * packages/ribo-ui-react/src/context.browser.test.tsx and the e2e suite.
 */

import { Recorder, createMemoryBackend, openStorage, type Storage } from "@azx/ribo-core";
import type { AnyRecorder, RiboInstances, RiboProvider } from "@azx/ribo-ui-react";

// #region usage
// The host owns lifetime, above React: construct the engine instances in a
// stable place — a module singleton, or useMemo — and hand them to the
// provider unchanged. The provider never constructs an instance and never
// memoizes value; a host that rebuilds the object inline every render hands
// every hook a new instance to resubscribe to.
const recorder: AnyRecorder = new Recorder();
const storage: Storage = await openStorage({ backend: createMemoryBackend("field-app") });

const value: RiboInstances = { recorder, storage };

// The provider itself, checked against the real component's props type. There
// is no JSX here (this file is compiled, not rendered), so RiboProvider is
// exercised through its parameter type instead of an element: the same object
// a host would pass as <RiboProvider value={...}>.
const providerProps: Parameters<typeof RiboProvider>[0] = { value, children: null };
// #endregion usage

// The render itself is the host's:
//   <RiboProvider {...providerProps}><App /></RiboProvider>
// Every field of RiboInstances is optional — a host using only capture never
// opens a database, and the hook that needs an absent instance throws with
// instructions for making one.
console.log(providerProps.value === value, value.recorder === recorder);
