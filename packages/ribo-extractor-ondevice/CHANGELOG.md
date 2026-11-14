# @azx/ribo-extractor-ondevice

## 0.2.0

### Minor Changes

- 85e3505: Follow @azx/ribo-core's rename of `ChatRequest.response_format` to `ChatRequest.responseFormat`. The on-device chat transport's request body is unchanged.
- e76e1db: Remove `WHITESPACE_LOOP_THRESHOLD` and `isLoopingOutput` from the public barrel — loop detection is an implementation detail of the on-device extractor. If you relied on one, open an issue.

### Patch Changes

- Updated dependencies [a39efc5]
- Updated dependencies [85e3505]
- Updated dependencies [e76e1db]
  - @azx/ribo-core@0.2.0

## 0.1.0

### Minor Changes

- 7fba323: First release.

### Patch Changes

- Updated dependencies [7fba323]
- Updated dependencies [48c0647]
- Updated dependencies [c6e52d8]
  - @azx/ribo-core@0.1.0
