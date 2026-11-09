# The StorageBackend port and the conformance kit

A `StorageBackend` is the contract durable storage implements: fifteen mechanical operations over
three logical collections, with a **closed set of three finders** rather than a query language.
The conformance kit (`@azx/ribo-core/testing`) makes the contract's behavioural obligations
executable — a backend that satisfies the types and fails the kit is not an implementation of
this port.

## When to reach for it

This is the page for **backend authors**: anyone implementing the port, or arguing about widening
it. Reach for the [Offline & Storage](/guide/offline-and-storage) guide to use storage rather than
build it, the [Migrations guide](/guide/migrations) for the upgrade ladders the kit deliberately
does not check, and the [Plugin Storage guide](/guide/plugin-storage) for the declared-store
layer above the port. Read `docs/roadmap/design/storage-port-design.md` §4 before widening the
interface: the finders are a closed set on purpose.

## Usage

The example runs the real kit against core's in-memory backend — the same suite the RxDB backend
passes in its own browser tests:

<<< @/api/examples/storage-port.run.ts#usage

## Options

There are no options and no defaults on the port — it is a contract, not a factory. The kit takes
a **subject** (the backend's factories, not just an instance) and an assertion seam, so a
validating backend can build documents its own schema accepts:

| Member                                      | On                      | Type                                | Default      | What it does                                                                                                                                  |
| ------------------------------------------- | ----------------------- | ----------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBackend`                             | the subject             | `(name) => Promise<StorageBackend>` | **required** | Open a backend on a database name. Called more than once with the same name by the cross-context test — two handles must share durable state. |
| `makeCapture` / `makeSession` / `makeEntry` | the subject             | document factories                  | **required** | Build one valid document. The kit cannot know what a validating backend requires — the factories fill in whatever the storage demands.        |
| `removableCaptureField`                     | the subject             | `string`                            | **required** | The name of a genuinely OPTIONAL capture field a modifier may delete — deleting a required field would be refused for the wrong reason.       |
| `expect`                                    | the harness             | `Expect`                            | **required** | The assertion seam (`toBe` / `toEqual` / `toBeUndefined`), structural so any runner satisfies it.                                             |
| `describe` / `it`                           | `runStorageConformance` | `ConformanceRunner`                 | **required** | The runner adapter. `defineStorageConformanceCases` needs no runner at all — the cases are inert data.                                        |

Defaults are read from `packages/ribo-core/src/storage/port.ts` and
`packages/ribo-core/src/storage/conformance.ts` — the same files the Errors section is read
from.

## Return value

- `defineStorageConformanceCases(subject, expect)` — the suite as data: a list of `ConformanceCase`
  (`{ name, run }`), bound to one backend and one assertion style. A third party mapping the list
  onto their own runner calls this and nothing else.
- `registerStorageConformanceCases(label, cases, runner)` — registers the list on a runner; the
  kit's single `describe`/`it` touchpoint.
- `runStorageConformance(label, harness)` — the composed form the repo's own backends use.

The kit is published at the `@azx/ribo-core/testing` subpath so a backend author can depend on it
while a consumer importing `@azx/ribo-core` never pulls test scaffolding into a bundle. It
imports no test runner.

## Errors

The cases throw when a behavioural obligation fails, and the obligations are the contract:

- **No observable window between a document and its blobs** — `watch` must never publish an
  insert whose blob `getBlob` cannot yet answer.
- **`insertNext` is atomic across contexts** sharing the database, and the first value allocated
  into an empty collection is `0` — read-highest-then-insert is the race the port exists to close.
- **`modify` never loses an update** — concurrent modifies each changing a different field both
  survive.
- **`putBlob` rejects when the document does not exist** — backends disagree by default here, and
  silently accepting orphans bytes no sweep will ever find.
- Two handles on one name observe each other's writes.

What the kit does NOT check: the migration ladders. They are exported values, not port methods,
so a backend can pass every conformance case and still destroy data on its first upgrade — that
part is a contract you keep, not one the kit enforces.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims.

<<< @/api/examples/storage-port.run.ts

## Related APIs

- [`openStorage`](/api/open-storage) — the container built over a backend, and the memory backend
  the example runs on.
- [`createRelay`](/api/relay) — the queue whose durability this port underwrites.

## Guides that use it

- [Migrations](/guide/migrations) — the upgrade ladders the kit deliberately does not check.
- [Offline & Storage](/guide/offline-and-storage) — the durability model the port carries.

## Reference

- [`StorageBackend`](/reference/@azx/ribo-core/interfaces/StorageBackend.html) ·
  [`Finders`](/reference/@azx/ribo-core/interfaces/Finders.html) ·
  [`CollectionName`](/reference/@azx/ribo-core/type-aliases/CollectionName.html) ·
  [`StoredDocument`](/reference/@azx/ribo-core/type-aliases/StoredDocument.html) ·
  [`BlobDescriptor`](/reference/@azx/ribo-core/interfaces/BlobDescriptor.html)
- [`runStorageConformance`](/reference/@azx/ribo-core/testing/functions/runStorageConformance.html) ·
  [`registerStorageConformanceCases`](/reference/@azx/ribo-core/testing/functions/registerStorageConformanceCases.html) ·
  [`defineStorageConformanceCases`](/reference/@azx/ribo-core/testing/functions/defineStorageConformanceCases.html) ·
  [`Expect`](/reference/@azx/ribo-core/testing/type-aliases/Expect.html)
