import { describe, expect, test } from "vitest";

import { acceptAnySuccess } from "./arbitration.js";
import { fallbackExtractor } from "./fallback-extractor.js";
import { stampStrategy } from "./extraction-observer.js";
import type { ExtractionUnit } from "./extraction-observer.js";
import type { Extractor } from "./extractor.js";

// §0.3: the composite forwards nothing because it intercepts nothing — the
// candidates were built with the observer already, and `stampStrategy` is how
// attribution is recovered. A `fallbackExtractor` wrapping two extractors that
// each emit units through an observer the CALLER configured must deliver every
// inner unit to the caller, not only the composite's own attempts.

describe("composite observer forwarding", () => {
  test("a fallbackExtractor wrapping two fake extractors delivers every inner unit to the caller", async () => {
    const events: ExtractionUnit[] = [];
    const onUnit = (e: ExtractionUnit): void => {
      events.push(e);
    };

    const groupStart: ExtractionUnit = {
      id: "u1",
      unit: "group",
      phase: "start",
      attempt: 1,
      key: "attics",
      part: 1,
      parts: 1,
    };
    const groupDone: ExtractionUnit = {
      id: "u1",
      unit: "group",
      phase: "done",
      attempt: 1,
      key: "attics",
      part: 1,
      parts: 1,
    };
    const wholeStart: ExtractionUnit = {
      id: "u2",
      unit: "whole",
      phase: "start",
      attempt: 1,
    };
    const wholeDone: ExtractionUnit = {
      id: "u2",
      unit: "whole",
      phase: "done",
      attempt: 1,
    };

    // First extractor fails; its events still arrive because the caller
    // configured the observer on it directly.
    const first: Extractor<Record<string, unknown>> = {
      extract: async () => {
        onUnit(groupStart);
        onUnit(groupDone);
        throw new Error("first extractor failed");
      },
    };

    // Second extractor succeeds; its events arrive the same way.
    const second: Extractor<Record<string, unknown>> = {
      extract: async () => {
        onUnit(wholeStart);
        onUnit(wholeDone);
        return { fields: {}, usage: { calls: 1 } };
      },
    };

    const composite = fallbackExtractor(
      [
        { strategy: "first", extractor: first },
        { strategy: "second", extractor: second },
      ],
      acceptAnySuccess,
    );

    await composite.extract({ text: "the transcript", annotations: {} });

    // Every inner unit was delivered — not just the composite's own attempts.
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.unit)).toEqual(["group", "group", "whole", "whole"]);
  });

  test("stampStrategy applied by hand produces the same attribution instanceLadder produces internally", async () => {
    const events: ExtractionUnit[] = [];
    const onUnit = (e: ExtractionUnit): void => {
      events.push(e);
    };

    const stampedFirst = stampStrategy("first", onUnit);
    const stampedSecond = stampStrategy("second", onUnit);

    const groupStart: ExtractionUnit = {
      id: "u1",
      unit: "group",
      phase: "start",
      attempt: 1,
      key: "attics",
      part: 1,
      parts: 1,
    };
    const wholeStart: ExtractionUnit = {
      id: "u2",
      unit: "whole",
      phase: "start",
      attempt: 1,
    };

    const first: Extractor<Record<string, unknown>> = {
      extract: async () => {
        stampedFirst?.(groupStart);
        throw new Error("first failed");
      },
    };

    const second: Extractor<Record<string, unknown>> = {
      extract: async () => {
        stampedSecond?.(wholeStart);
        return { fields: {}, usage: { calls: 1 } };
      },
    };

    const composite = fallbackExtractor(
      [
        { strategy: "first", extractor: first },
        { strategy: "second", extractor: second },
      ],
      acceptAnySuccess,
    );

    await composite.extract({ text: "the transcript", annotations: {} });

    expect(events).toHaveLength(2);
    expect(events[0]?.strategy).toBe("first");
    expect(events[1]?.strategy).toBe("second");
  });
});
