import { expect, test } from "vitest";
import { userEvent } from "@vitest/browser/context";

/**
 * @file Does a synthesised click satisfy the Prompt API's user-activation requirement?
 *
 * Chrome refuses to download the on-device model unless `create()` is called from a
 * user gesture, and an automated run has none — `NotAllowedError` is what a bare call
 * gets, measured in both real Chrome and Playwright's Chromium.
 *
 * This decides whether any real-model acceptance run can ever be automated. Playwright
 * dispatches input through CDP as *trusted* events, so a click it synthesises may well
 * count as activation. Nobody has checked.
 *
 * **It deliberately does not complete a download.** A two-second abort caps it: if the
 * call is refused we learn that immediately, and if it is accepted we learn that from
 * the abort rather than from several gigabytes arriving. Whether the model then
 * *persists* between runs is the separate, more expensive question this does not touch.
 */

interface MaybeSession {
  prompt?(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

interface MaybeLanguageModel {
  availability(): Promise<string>;
  create(options?: { signal?: AbortSignal }): Promise<MaybeSession>;
}

function languageModel(): MaybeLanguageModel | undefined {
  return (globalThis as { LanguageModel?: MaybeLanguageModel }).LanguageModel;
}

test("records whether a synthesised click grants user activation", async ({ skip }) => {
  const model = languageModel();
  skip(model === undefined, "no LanguageModel global in this browser");

  const availability = await model!.availability();
  skip(
    availability === "available",
    "model already downloaded — the gesture rule does not apply, so this proves nothing",
  );
  skip(availability === "unavailable", "model cannot run here at all");

  const button = document.createElement("button");
  button.textContent = "arm";
  document.body.append(button);

  let outcome = "handler never ran";
  button.addEventListener("click", () => {
    // Everything below happens inside the click handler, which is the only place
    // user activation exists. Deliberately not awaited here — the handler must not
    // become async before `create()` is reached, or the activation is already spent.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2_000);
    void model!
      .create({ signal: controller.signal })
      .then(async (session) => {
        // `create()` resolving is not the same as a usable model. Availability still
        // reads `downloadable` after this call, which cannot be reconciled with "the
        // promise settles only once the download finishes" — so the session may be
        // hollow. One tiny prompt settles it: text back means the model genuinely
        // runs here and real-model tests can be automated; anything else means the
        // session was a shell and the gesture result, while real, buys nothing.
        if (typeof session?.prompt !== "function") {
          outcome = "ACCEPTED but session has no prompt() — hollow session";
          return;
        }
        try {
          const answer = await session.prompt("Reply with the single word: ok");
          outcome = `USABLE — session answered ${JSON.stringify(answer.slice(0, 60))}`;
        } catch (error) {
          const name = error instanceof Error ? error.name : typeof error;
          const message = error instanceof Error ? error.message : String(error);
          outcome = `ACCEPTED but prompt() failed — ${name}: ${message.slice(0, 120)}`;
        } finally {
          session.destroy?.();
        }
      })
      .catch((error: unknown) => {
        const name = error instanceof Error ? error.name : typeof error;
        outcome =
          name === "NotAllowedError"
            ? "REFUSED — NotAllowedError; a synthesised click does NOT grant activation"
            : `ACCEPTED-THEN-${name} — the gesture was accepted; the call ended as ${name}`;
      });
  });

  await userEvent.click(button);
  // Long enough for the abort deadline plus a short prompt to come back.
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  console.info(`[prompt-api gesture] ${outcome}`);
  button.remove();

  // Measured 2026-08-26 under HeadlessChrome 149: the session answers
  // "On-device model is not available in Chromium, this API is just a stub".
  //
  // So Playwright's Chromium implements the Prompt API as a **stub** — present,
  // reporting `downloadable`, faithfully enforcing the gesture rule, and returning
  // canned text instead of running a model. That is a more dangerous shape than a
  // missing API: a real-model test here would not skip, it would pass against a
  // fixed string and look like coverage.
  //
  // This assertion is the tripwire. If Chromium ever ships a working model, the
  // stub marker disappears and this fails, which is the moment to revisit
  // automating the real-model acceptance runs.
  expect(outcome).toMatch(/not available in Chromium|stub/i);
});
