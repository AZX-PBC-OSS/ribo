# The ORT Runtime Cache

The ONNX Runtime WASM files that Whisper runs on must be served **same-origin**. The host app copies
them out of `onnxruntime-web/dist` into a `/ort/` path and the transcriber is pointed at them via
`wasmPaths` — never bundled, never cross-origin.

::: info Content coming
Full narrative lands in the content pass.
:::
