import { isPermanentlyUnavailable } from "@azx/ribo-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PdfjsTranscriber } from "./index.js";
import { PDFJS_ENGINE } from "./config.js";
import type { PdfjsModule } from "./config.js";

/**
 * Capability tests for the pdf.js transcriber — the Task 5 must-fail tests from
 * `docs/roadmap/design/document-transcription-plan.md`.
 *
 * These run as unit (node) tests. `Worker` is not a global in Node, so the
 * tests that exercise the `not-configured` and `ready` paths stub it via
 * `vi.stubGlobal`. The `capability()` method itself only checks
 * `typeof Worker` — it never constructs one — so a class stub is sufficient.
 *
 * `capability()` must not load pdf.js. The contract says it is called often and
 * expected to be cheap, so a probe that quietly pulls in ~89 KB is the failure
 * the "does not load" test exists for. The transcriber accepts an internal
 * `loadPdfjs` injection point; the test injects a counting loader and asserts
 * the count stays at zero across many capability() calls.
 */

const FAKE_WORKER_SRC = "https://example.com/pdf.worker.min.mjs";

beforeEach(() => {
  // `Worker` exists in a browser but not in Node. Stub it so capability()'s
  // `typeof Worker` check passes, exercising the not-configured / ready paths.
  vi.stubGlobal("Worker", class MockWorker {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PdfjsTranscriber — capability", () => {
  test("a missing worker URL yields not-configured, and isPermanentlyUnavailable is false for it", async () => {
    const t = new PdfjsTranscriber({});
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("not-configured");
    }
    // A missing worker URL is a situation, not a fact about the hardware — a
    // host may supply one later, so capability should be re-probed.
    expect(isPermanentlyUnavailable(cap)).toBe(false);
  });

  test("a configured worker URL yields ready", async () => {
    const t = new PdfjsTranscriber({ workerSrc: FAKE_WORKER_SRC });
    const cap = await t.capability();

    expect(cap.status).toBe("ready");
  });

  test("capability() does not load pdf.js", async () => {
    // The contract says capability() is called often and expected to be cheap.
    // A probe that quietly pulls in 89 KB is the failure this test exists for.
    // Inject a counting loader and assert the count stays at zero.
    let loadCount = 0;
    const fakeModule: PdfjsModule = {
      getDocument: () => ({ promise: Promise.resolve({} as never) }),
      GlobalWorkerOptions: { workerSrc: "" },
    };
    const t = new PdfjsTranscriber({
      workerSrc: FAKE_WORKER_SRC,
      loadPdfjs: () => {
        loadCount++;
        return Promise.resolve(fakeModule);
      },
    });

    // Call capability many times — it should be cheap and load nothing.
    for (let i = 0; i < 10; i++) {
      await t.capability();
    }
    expect(loadCount).toBe(0);
  });

  test("no Worker global yields unsupported-platform, which is permanent", async () => {
    vi.unstubAllGlobals();

    const t = new PdfjsTranscriber({ workerSrc: FAKE_WORKER_SRC });
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("unsupported-platform");
    }
    // No Worker constructor is a permanent fact about the platform, not a
    // situation — correctly permanent.
    expect(isPermanentlyUnavailable(cap)).toBe(true);
  });

  test("the engine id is exactly pdfjs", () => {
    // The literal is asserted because it is persisted data — it rides into
    // every Transcript.engine this package produces and into the outbox
    // document. A rename is a migration, not a refactor.
    const t = new PdfjsTranscriber({});
    expect(t.engine).toBe("pdfjs");
    expect(PDFJS_ENGINE).toBe("pdfjs");
  });
});
