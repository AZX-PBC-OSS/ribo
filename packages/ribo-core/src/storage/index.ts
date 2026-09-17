/**
 * @file The storage subsystem's surface.
 *
 * Re-exports only, like the package barrel above it. The conformance kit is
 * deliberately **not** here: it is published separately under the `./testing`
 * subpath (`src/testing.ts`) so that importing `@azx/ribo-core` does not drag
 * test scaffolding into a consumer's bundle.
 *
 * The design is `docs/roadmap/design/storage-port-design.md`.
 */

export type {
  BlobDescriptor,
  BlobInput,
  CollectionName,
  EntryScopeKind,
  Finders,
  Modifier,
  StorageBackend,
  StoredDocument,
} from "./port.js";
