import { expect, expectTypeOf, test } from "vitest";

import { nextUnitId, stampStrategy } from "./extraction-observer.js";
import type {
  ExtractionObserver,
  ExtractionUnit,
  GroupUnit,
  PhaseUnit,
  WholeUnit,
} from "./extraction-observer.js";

// ---------------------------------------------------------------------------
// Runtime: nextUnitId and stampStrategy
// ---------------------------------------------------------------------------

test("nextUnitId returns a different value on each call", () => {
  const a = nextUnitId();
  const b = nextUnitId();
  expect(a).not.toBe(b);
});

test("stampStrategy sets strategy on a forwarded event and mutates nothing else", () => {
  const received: GroupUnit[] = [];
  const stamped = stampStrategy<GroupUnit>("tier2", (e) => {
    received.push(e);
  });

  const original: GroupUnit = {
    id: "u1",
    phase: "start",
    attempt: 1,
    unit: "group",
    key: "attics",
    part: 1,
    parts: 2,
  };
  stamped?.(original);

  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({ ...original, strategy: "tier2" });
  expect(original.strategy).toBeUndefined();
});

test("stampStrategy returns undefined when handed undefined", () => {
  const stamped = stampStrategy<GroupUnit>("tier1", undefined);
  expect(stamped).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Type-level: property contravariance vs method bivariance
// ---------------------------------------------------------------------------
//
// These are enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`, which
// `./check.sh` runs), not by the Vitest run above — esbuild strips types without
// checking them. Each `@ts-expect-error` below is itself the assertion: if the
// error it expects ever stops happening, tsc fails with "Unused
// '@ts-expect-error' directive". In particular, declaring `onUnit` as a method
// (`onUnit?(…): void`) instead of a property (`onUnit?: (…: U) => void`) makes
// the method bivariant, which silences the rejection in test 2, makes the
// directive unused, and fails the build — which is how you know the test is
// testing the syntax choice.

test("a broad handler is assignable to every narrowed observer", () => {
  const broad: (e: ExtractionUnit) => void = () => {};
  expectTypeOf(broad).toMatchTypeOf<ExtractionObserver<GroupUnit>["onUnit"]>();
  expectTypeOf(broad).toMatchTypeOf<ExtractionObserver<WholeUnit>["onUnit"]>();
  // Wave 6 retired the inventory/instance/gapfill unit types; the assignability
  // property is re-expressed over the surviving units — single-unit observers
  // and unions of them alike.
  expectTypeOf(broad).toMatchTypeOf<ExtractionObserver<PhaseUnit | GroupUnit>["onUnit"]>();
  expectTypeOf(broad).toMatchTypeOf<ExtractionObserver<WholeUnit | PhaseUnit>["onUnit"]>();
  expectTypeOf(broad).toMatchTypeOf<ExtractionObserver<PhaseUnit>["onUnit"]>();
  expectTypeOf(broad).toMatchTypeOf<ExtractionObserver["onUnit"]>();
});

test("a narrow handler is rejected by a wide observer", () => {
  const narrow: (e: GroupUnit) => void = () => {};
  // This is the test that catches method syntax: under `onUnit?(…): void`
  // (bivariant) this assignment compiles, the directive goes unused, and the
  // build fails with TS2578. Under `onUnit?: (…: U) => void` (contravariant)
  // the assignment is correctly rejected. Do not delete the directive to "fix"
  // the error — the error IS the test.
  // @ts-expect-error — a handler narrower than the site is rejected under
  // property-typed contravariance.
  const _slot: ExtractionObserver<ExtractionUnit>["onUnit"] = narrow;
  expect(_slot).toBe(narrow);
});

test("a GroupUnit handler reads group fields and rejects instance fields", () => {
  const observer: ExtractionObserver<GroupUnit> = {
    onUnit: (event) => {
      void event.key;
      void event.part;
      void event.parts;
      // @ts-expect-error — GroupUnit has no `instance`; a `case "instance"` at a
      // GroupUnit site is a compile error, not dead code.
      void event.instance;
    },
  };
  expect(observer.onUnit).toBeDefined();
});

test("fields are required where they apply and absent where they do not", () => {
  // @ts-expect-error — WholeUnit has no `part`; it does not compile with one.
  const _w: WholeUnit = { id: "u1", phase: "start", attempt: 1, unit: "whole", part: 1 };

  // @ts-expect-error — GroupUnit requires `part`; a literal missing one does not compile.
  const _g: GroupUnit = {
    id: "u2",
    phase: "start",
    attempt: 1,
    unit: "group",
    key: "attics",
    parts: 2,
  };

  expect(_w).toBeDefined();
  expect(_g).toBeDefined();
});

test("an exhaustive switch over ExtractionUnit narrows each arm and reaches never", () => {
  const check = (event: ExtractionUnit): void => {
    switch (event.unit) {
      case "whole":
        void event.id;
        break;
      case "group":
        void event.key;
        void event.part;
        void event.parts;
        break;
      case "phase":
        void event.pass;
        void event.key;
        break;
      default: {
        // After an exhaustive switch over a discriminated union, event is never.
        const _: never = event;
        void _;
      }
    }
  };
  expect(check).toBeDefined();
  // Caveat: a single-variant U is an intersection, not a union, so the `never`
  // idiom above does NOT apply at a narrow site — the fields are read directly
  // there, which is the point.
});
