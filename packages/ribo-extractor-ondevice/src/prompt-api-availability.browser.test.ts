import { expect, test } from "vitest";

/**
 * @file Does the browser this suite runs in actually have Chrome's Prompt API?
 *
 * This is not a test of our code. It is the standing evidence behind a planning
 * decision, kept as a test so it re-checks itself on every run instead of being a
 * claim in a document that quietly goes stale.
 *
 * The design's acceptance work needs a real on-device model. The browser project
 * launches Playwright's bundled Chromium, and Gemini Nano arrives through *branded*
 * Chrome's component updater — so the model is expected to be absent here, which is
 * why spec §10's measurements were taken from a standalone page in real Chrome
 * rather than from this harness.
 *
 * **If this test starts reporting that the API is present, the plan's Task 12 should
 * be abandoned rather than built** — its whole purpose is routing around an absence
 * that would no longer exist.
 */

interface MaybeLanguageModel {
  availability(): Promise<string>;
}

function languageModel(): MaybeLanguageModel | undefined {
  return (globalThis as { LanguageModel?: MaybeLanguageModel }).LanguageModel;
}

test("records whether this browser exposes the Prompt API at all", () => {
  const present = languageModel() !== undefined;
  // Deliberately not an assertion either way — the value is the record, and a
  // hard expectation here would fail the suite on the day the answer changes,
  // which is the day we most want a passing run that tells us so.
  console.info(
    `[prompt-api] LanguageModel global present in this browser: ${present}. ` +
      `User agent: ${navigator.userAgent}`,
  );
  expect(typeof present).toBe("boolean");
});

test("reports availability when the API is present, and skips when it is not", async ({ skip }) => {
  const model = languageModel();
  skip(model === undefined, "no LanguageModel global — expected under Playwright's Chromium");

  const availability = await model!.availability();
  console.info(`[prompt-api] availability(): ${availability}`);
  expect(["unavailable", "downloadable", "downloading", "available"]).toContain(availability);
});

test("records what create() does here, without waiting for a download", async ({ skip }) => {
  const model = languageModel() as
    { availability(): Promise<string>; create(o?: unknown): Promise<unknown> } | undefined;
  skip(model === undefined, "no LanguageModel global");

  // This is the question Task 12 actually turns on. `downloadable` says the API is
  // wired up; it does not say a download can be *started* here. Real Chrome refuses
  // without a user gesture (`NotAllowedError`), and an automated run has none — so
  // the error we get back tells us whether this environment can ever reach a model.
  //
  // An abort signal caps this at two seconds: if it does start downloading, we want
  // the finding, not several gigabytes.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    await model!.create({ signal: controller.signal });
    console.info("[prompt-api] create(): resolved — a session was obtained");
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    console.info(`[prompt-api] create(): ${name} — ${message}`);
  } finally {
    clearTimeout(timer);
  }
  expect(true).toBe(true);
});
