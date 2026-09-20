import { describe, expect, test } from "vitest";

import * as api from "./index.js";
import { threePhaseExtractor as threePhaseExtractorModule } from "./three-phase-extractor.js";

/**
 * The barrel is the contract of what consumers may depend on. The four on-device
 * phases moved to `@azx/ribo-core` in SP4a wave 5 (which exports them with their
 * note keys and the `extractGroups` schema walk), so the pins here cover what
 * this package still owns: the preset is the very value its defining module exports.
 */

describe("the barrel's preset export", () => {
  test("threePhaseExtractor is the value its defining module exports, not a re-creation", () => {
    expect(api.threePhaseExtractor).toBe(threePhaseExtractorModule);
  });
});
