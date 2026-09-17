import { expect, test } from "vitest";

import { emptyNotes, noteKey } from "./phase-notes.js";
import type { NoteKey } from "./phase-notes.js";

// ---------------------------------------------------------------------------
// Type-level: the brand makes a mismatched key a compile error
// ---------------------------------------------------------------------------
//
// These are enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`, which
// `./check.sh` runs), not by the Vitest run — esbuild strips types without
// checking them. Each `@ts-expect-error` below is itself the assertion: if the
// error it expects ever stops happening, tsc fails with "Unused
// '@ts-expect-error' directive" (TS2578). See extraction-observer.test.ts for
// the house pattern.
//
// The brand's type is deliberately a FUNCTION type, `(value: T) => T`, and not
// a bare `T`: a function puts `T` in both input and output position, making
// `NoteKey<T>` invariant in `T` under `strictFunctionTypes`. Invariance is the
// whole mechanism — a covariant brand would let a `NoteKey<Roster>` slip into a
// `NoteKey<PresenceMap>` slot and the wrong-type read below would typecheck.
// It is also why the brand is declared as a property with an arrow type and
// never as a method signature: method syntax is checked bivariantly, which
// would silently defeat the invariance (see the `method-signature-style` lint
// rule every package turns on).

// Two small local interfaces for the variance tests — deliberately not adapter
// types: core must not depend on any adapter, and hand-written shapes make the
// claim readable.
interface Roster {
  readonly candidates: readonly string[];
}

interface PresenceMap {
  readonly present: Readonly<Record<string, boolean>>;
}

const rosterKey = noteKey<Roster>("roster");
const presenceKey = noteKey<PresenceMap>("presence");
const presenceValue: PresenceMap = { present: { attic: true } };

test("reading a key at the wrong type is a compile error", () => {
  const notes = emptyNotes().set(rosterKey, { candidates: ["attic"] });
  // @ts-expect-error — a roster key read as presence data is a compile error,
  // not a runtime surprise: the brand refuses the mismatched key.
  const wrong: PresenceMap | undefined = notes.get<PresenceMap>(rosterKey);
  void wrong;
});

test("storing a value of the wrong type under a key is a compile error", () => {
  // @ts-expect-error — `set` infers T from the key; a PresenceMap under a
  // roster key does not typecheck.
  const notes = emptyNotes().set(rosterKey, presenceValue);
  void notes;
});

test("a NoteKey is not assignable to a differently-branded slot, either direction", () => {
  // @ts-expect-error — Roster-branded key into a PresenceMap slot.
  const wrongSlot: NoteKey<PresenceMap> = rosterKey;
  void wrongSlot;
  // @ts-expect-error — and the mirror direction, because the brand is invariant.
  const wrongSlotToo: NoteKey<Roster> = presenceKey;
  void wrongSlotToo;
});

// ---------------------------------------------------------------------------
// Runtime: the bag's behaviour
// ---------------------------------------------------------------------------

test("get on an absent key returns undefined", () => {
  expect(emptyNotes().get(rosterKey)).toBeUndefined();
});

test("set returns a new Notes and leaves the original unchanged", () => {
  const empty = emptyNotes();
  const next = empty.set(rosterKey, { candidates: ["attic"] });
  expect(next).not.toBe(empty);
  // The original still returns undefined — the immutability is pinned, not assumed.
  expect(empty.get(rosterKey)).toBeUndefined();
  expect(next.get(rosterKey)).toEqual({ candidates: ["attic"] });
});

test("set twice under the same key overwrites", () => {
  const notes = emptyNotes()
    .set(rosterKey, { candidates: ["first"] })
    .set(rosterKey, { candidates: ["second"] });
  expect(notes.get(rosterKey)).toEqual({ candidates: ["second"] });
});

test("keys lists the plain string ids of everything set, in insertion order", () => {
  const notes = emptyNotes().set(rosterKey, { candidates: [] }).set(presenceKey, presenceValue);
  expect(notes.keys).toEqual(["roster", "presence"]);
});

test("keys on emptyNotes() is empty", () => {
  expect(emptyNotes().keys).toEqual([]);
});

test("noteKey<unknown> round-trips any value, so the open-bag escape hatch survives", () => {
  const scratch = noteKey<unknown>("scratch");
  const notes = emptyNotes().set(scratch, 42);
  expect(notes.get(scratch)).toBe(42);
  expect(notes.keys).toEqual(["scratch"]);
});
