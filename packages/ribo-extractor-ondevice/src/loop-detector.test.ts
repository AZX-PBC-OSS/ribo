import { describe, expect, test } from "vitest";

import { isLoopingOutput, WHITESPACE_LOOP_THRESHOLD } from "./loop-detector.js";

describe("isLoopingOutput", () => {
  test("a realistic pretty-printed extraction response is not looping", () => {
    const response = JSON.stringify(
      {
        hvac: {
          fuel: {
            value: "Oil",
            confidence: 1,
            sourceSpan: "I'd say the boiler is oil fired",
          },
          systemType: {
            value: "Forced hot air",
            confidence: 0.92,
            sourceSpan: "the ducts are forced air",
          },
          age: {
            value: null,
            confidence: 0,
            sourceSpan: null,
          },
        },
        building: {
          insulation: {
            walls: {
              value: "Fiberglass batts",
              confidence: 0.78,
              sourceSpan: "walls have fiberglass batts",
            },
            attic: {
              value: "Blown cellulose",
              confidence: 0.85,
              sourceSpan: "attic is blown cellulose",
            },
          },
        },
      },
      null,
      2,
    );

    expect(response.length).toBeGreaterThan(450);
    expect(response.length).toBeLessThan(950);
    expect(isLoopingOutput(response)).toBe(false);
  });

  test("content followed by 80 or more newlines is looping", () => {
    const output = '{"ok": true}' + "\n".repeat(WHITESPACE_LOOP_THRESHOLD);
    expect(isLoopingOutput(output)).toBe(true);
  });

  test("content followed by 80 or more mixed spaces and newlines is looping", () => {
    const tail = "\n  ".repeat(40); // 40 * 3 = 120 chars, all whitespace
    const output = "{" + tail;
    expect(output.length).toBeGreaterThanOrEqual(WHITESPACE_LOOP_THRESHOLD + 1);
    expect(isLoopingOutput(output)).toBe(true);
  });

  test("a string shorter than the threshold is not looping, whatever it contains", () => {
    const output = "\n\n\n";
    expect(output.length).toBeLessThan(WHITESPACE_LOOP_THRESHOLD);
    expect(isLoopingOutput(output)).toBe(false);
  });

  test("exactly 79 trailing whitespace characters is not looping; exactly 80 is", () => {
    const prefix = "{";
    expect(isLoopingOutput(prefix + " ".repeat(79))).toBe(false);
    expect(isLoopingOutput(prefix + " ".repeat(80))).toBe(true);
  });
});
