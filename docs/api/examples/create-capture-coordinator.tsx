/**
 * The type-checked example behind docs/api/create-capture-coordinator.html.
 *
 * Rendering hooks and a live capture session need React plus browser globals
 * (MediaRecorder, a microphone), so this file is never executed. It is
 * type-checked by the examples tsconfig (see docs/api/index.md), so the
 * wiring shown on the page is real. Runtime behaviour is covered by
 * packages/ribo-ui-react/src/capture-coordinator.browser.test.tsx.
 */

import { createCaptureCoordinator } from "@azx/ribo-ui-react";

// #region usage
// The host constructs the coordinator, like every other instance — the
// provider never creates one silently. Hand it to
// <RiboProvider value={{ captureCoordinator: coordinator }}>: useRecorder then
// registers the recorder's own capture session, and the handle it gets back
// unregisters it when the recording ends.
const coordinator = createCaptureCoordinator();
// #endregion usage

// Health reads: useWorkSafety subscribes through its own hook; a component
// that wants the stream directly reads it here. `active()` names the
// registered session, undefined between recordings.
const healthSub = coordinator.health$.subscribe((health) => console.log(health));
console.log(coordinator.active());
healthSub.unsubscribe();
