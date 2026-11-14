/**
 * @file The CLI backend preflight: is the binary installed, and does it answer?
 *
 * A CLI backend's transport is the user's own installed binary, so nothing in
 * this package can know whether it is there. The runner's per-case error
 * capture would turn a missing binary into "every case failed" — a
 * measurement-shaped lie, because a run that never reached a model measures
 * nothing. The preflight is the up-front check that refuses instead: one
 * spawn of `<binary> --version`, before the corpus is even loaded, so the
 * diagnostic names the missing binary rather than a corpus fault or a spend
 * refusal.
 *
 * It lives in its own file, beside the transport it guards, so the transport's
 * own diff stays limited to what the move allows. It is INTERNAL: the bin
 * imports it directly, and it is not exported from the package's public entry.
 *
 * The refusal is an `EvalError`, which extends the package's could-not-run
 * class — so the bin's existing exit-2 mapping covers it without a second
 * exit-code discipline.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliBackendName } from "./cli-chat.js";
import { EvalError } from "./eval/error.js";

/** How long the `--version` probe may run before the binary counts as not answering. */
const PREFLIGHT_TIMEOUT_MS = 15_000;

/**
 * The preflight's configuration.
 *
 * Every part of it is injectable, so a test can drive the refusals without a
 * real binary and without waiting for a real timeout.
 */
export interface CliPreflightOptions {
  /** Override `child_process.spawn` (tests). Defaults to the real one. */
  readonly spawnImpl?: typeof spawn;
  /** How long the probe may run (ms). Default 15_000. */
  readonly timeoutMs?: number;
}

/** The message of a thrown fault — a non-Error sentinel must not read "undefined". */
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Check that the backend's binary is installed and answers `--version`.
 *
 * The spawn is exactly one, with the binary's own name as the command and
 * `--version` as its only argument: the cheapest question that proves the
 * binary exists and runs. It resolves when the process exits 0 within the
 * timeout, and rejects with an `EvalError` naming the binary and the failure
 * class otherwise.
 * @param backend - The CLI backend whose binary is checked.
 * @param options - The optional spawn override and timeout.
 * @returns Nothing; the promise settles when the probe has answered.
 * @throws {@link EvalError} when the binary is missing, exits non-zero, or does not answer.
 */
export async function preflightCliBackend(
  backend: CliBackendName,
  options: CliPreflightOptions = {},
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  // A throwaway temp cwd, exactly like the transport's own shell-out: an
  // agentic CLI must never roam the operator's repository to answer `--version`.
  const cwd = mkdtempSync(join(tmpdir(), "ribo-cli-preflight-"));
  try {
    await new Promise<void>((resolvePromise, reject) => {
      // stdout is discarded, not piped: a binary that printed a lot to it
      // would fill an unread pipe and block forever, which the timeout would
      // then report as "did not answer".
      const child = spawnImpl(backend, ["--version"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      let settled = false;

      const settle = (): void => {
        settled = true;
        // `timer` is assigned below, before any handler can run: the handlers
        // fire asynchronously, so by the time `settle` is called the timer
        // exists.
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        settle();
        child.kill("SIGKILL");
        reject(
          new EvalError(
            `the ${backend} CLI did not answer --version within ${Math.round(timeoutMs / 1000)}s — ` +
              "the backend cannot be run (fix: check that the CLI starts and is authenticated, then " +
              "re-run)",
          ),
        );
      }, timeoutMs);

      child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
      child.on("error", (cause: Error) => {
        settle();
        reject(
          new EvalError(
            `the ${backend} CLI was not found on PATH — the backend cannot be run ` +
              `(${messageOf(cause)}) (fix: install the ${backend} CLI and sign in, then re-run)`,
          ),
        );
      });
      child.on("close", (code: number | null) => {
        if (settled) return;
        settle();
        if (code === 0) {
          resolvePromise();
          return;
        }
        reject(
          new EvalError(
            `the ${backend} CLI did not answer --version — it exited with code ${String(code)}` +
              `${err.length === 0 ? "" : `: ${err.slice(0, 200)}`} (fix: check that the ${backend} ` +
              "CLI is installed and authenticated, then re-run)",
          ),
        );
      });
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
