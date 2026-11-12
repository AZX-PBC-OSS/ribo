import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

/**
 * @file Build the CLI once per test run, shared by every suite that drives the
 * built bin. Each suite used to build in its own `beforeAll`; tsdown cleans
 * `dist/` first, so parallel suites deleted each other's bin mid-run.
 */

declare module "vitest" {
  export interface ProvidedContext {
    riboCliRunToken: string;
  }
}

export const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const PACKAGE_DIR = join(REPO_ROOT, "packages", "ribo-cli");
const LOCK = join(PACKAGE_DIR, ".build-lock");
// A crashed holder's lock is broken after this long; a cold build is well under it.
const STALE_LOCK_MS = 5 * 60_000;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const acquire = (): void => {
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_LOCK_MS) rmSync(LOCK, { recursive: true });
      } catch {
        // The holder released it between the two calls.
      }
      sleep(100);
    }
  }
};

/** The built bin's path, building it first unless this run already has. */
export function buildCliOnce(): string {
  // Outside dist/, so the marker can never be packed.
  const marker = join(tmpdir(), `ribo-cli-built-${inject("riboCliRunToken")}`);
  acquire();
  try {
    if (!existsSync(marker)) {
      execFileSync("pnpm", ["--filter", "@azx/ribo-cli", "build"], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
      writeFileSync(marker, "");
    }
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
  return join(PACKAGE_DIR, "dist", "bin.js");
}
