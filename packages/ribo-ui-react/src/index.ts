/**
 * @file The public surface of `@azx/ribo-ui-react`.
 *
 * Re-exports only, like `@azx/ribo-core`'s barrel. This package is a **headless
 * hook layer**: no components beyond `RiboProvider`, no markup, no stylesheet.
 * Rendering is the host's; these hooks only wire core's engine to React state.
 */

export { RiboProvider } from "./RiboProvider.js";
export type { AnyRecorder, RiboInstances } from "./context.js";
