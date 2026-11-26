/**
 * @file Non-destructive authoring output, using only local temporary files and
 * injected filesystem faults. No backend, model, network or credential is read.
 */
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { OperatorError } from "./error.js";
import { writeOperatorOutput } from "./output.js";
import type { OperatorOutputFileSystem, OperatorOutputRequest } from "./output.js";

const ARTIFACT_DOCUMENT = {
  version: 1,
  pieces: [{ name: "Home", paths: ["home.address"] }],
};
const ARTIFACT = `${JSON.stringify(ARTIFACT_DOCUMENT, null, 2)}\n`;
const REVIEW = "review: confirm the Home piece before writing back\n";
const ORIGINAL_INPUT = Buffer.from('{"stored":true,"bytes":"stay-exact"}\n');

interface CapturedStream {
  readonly stream: { write: (text: string) => void };
  readonly text: () => string;
}

function capturedStream(): CapturedStream {
  let text = "";
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
      },
    },
    text: () => text,
  };
}

function request(kind: "create" | "update", input: string, out?: string): OperatorOutputRequest {
  const common = { artifact: ARTIFACT, review: REVIEW, ...(out === undefined ? {} : { out }) };
  return kind === "create" ? { kind, ...common } : { kind, input, ...common };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ribo-cli-operator-output-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("shared non-destructive operator output", () => {
  test("update refuses input-as-output through resolved aliases before emitting or staging content", async () => {
    const input = join(directory, "plan.json");
    await writeFile(input, ORIGINAL_INPUT);
    const aliases = [
      input,
      join(directory, ".", "plan.json"),
      join(directory, "nested", "..", "plan.json"),
      "plan.json",
    ];

    for (const out of aliases) {
      const stdout = capturedStream();
      const stderr = capturedStream();

      const pending = writeOperatorOutput(request("update", input, out), {
        cwd: directory,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      await expect(pending).rejects.toBeInstanceOf(OperatorError);
      await expect(pending).rejects.toThrow(/input.*output|output.*input/iu);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe("");
      expect(await readFile(input)).toEqual(ORIGINAL_INPUT);
      expect(await readdir(directory)).toEqual(["plan.json"]);
    }
  });

  test("creation and update refuse an existing destination without changing either file or emitting content", async () => {
    for (const kind of ["create", "update"] as const) {
      const caseDirectory = join(directory, kind);
      await mkdir(caseDirectory);
      const input = join(caseDirectory, `${kind}-input.json`);
      const out = join(caseDirectory, `${kind}-existing.json`);
      const existing = Buffer.from(`existing ${kind} bytes\n`);
      await writeFile(input, ORIGINAL_INPUT);
      await writeFile(out, existing);
      const stdout = capturedStream();
      const stderr = capturedStream();

      const pending = writeOperatorOutput(request(kind, input, out), {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      await expect(pending).rejects.toBeInstanceOf(OperatorError);
      await expect(pending).rejects.toThrow(/already exists/iu);
      expect(await readFile(out)).toEqual(existing);
      expect(await readFile(input)).toEqual(ORIGINAL_INPUT);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe("");
      expect((await readdir(caseDirectory)).sort()).toEqual(
        [`${kind}-existing.json`, `${kind}-input.json`].sort(),
      );
    }
  });

  test.each(["create", "update"] as const)(
    "%s without --out emits exactly one parseable artifact on stdout and review only on stderr",
    async (kind) => {
      const input = join(directory, `${kind}-input.json`);
      await writeFile(input, ORIGINAL_INPUT);
      const stdout = capturedStream();
      const stderr = capturedStream();

      const result = await writeOperatorOutput(request(kind, input), {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(result).toEqual({ destination: "stdout" });
      expect(stdout.text()).toBe(ARTIFACT);
      expect(JSON.parse(stdout.text())).toEqual(ARTIFACT_DOCUMENT);
      expect(stderr.text()).toBe(REVIEW);
      expect(stdout.text()).not.toContain(REVIEW);
      expect(await readFile(input)).toEqual(ORIGINAL_INPUT);
      expect(await readdir(directory)).toEqual([`${kind}-input.json`]);
    },
  );

  test.each(["create", "update"] as const)(
    "%s to a distinct new file commits exactly the artifact, keeps stdout empty and returns the file",
    async (kind) => {
      const input = join(directory, `${kind}-input.json`);
      const out = join(directory, `${kind}-new.json`);
      await writeFile(input, ORIGINAL_INPUT);
      const stdout = capturedStream();
      const stderr = capturedStream();

      const result = await writeOperatorOutput(request(kind, input, out), {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(result).toEqual({ destination: "file", path: resolve(out) });
      expect(await readFile(out, "utf8")).toBe(ARTIFACT);
      expect(JSON.parse(await readFile(out, "utf8"))).toEqual(ARTIFACT_DOCUMENT);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe(REVIEW);
      expect(await readFile(input)).toEqual(ORIGINAL_INPUT);
      expect((await readdir(directory)).sort()).toEqual(
        [`${kind}-input.json`, `${kind}-new.json`].sort(),
      );
    },
  );

  test.each(["create", "update"] as const)(
    "%s cleans up an injected partial staged write and preserves every destination and input",
    async (kind) => {
      const input = join(directory, `${kind}-input.json`);
      const out = join(directory, `${kind}-failed.json`);
      await writeFile(input, ORIGINAL_INPUT);
      const stdout = capturedStream();
      const stderr = capturedStream();
      const fileSystem: OperatorOutputFileSystem = {
        lstat: (path) => lstat(path),
        writeFile: async (path) => {
          await writeFile(path, "partial staged bytes", { encoding: "utf8", flag: "wx" });
          throw new Error(`injected write failure ${randomUUID()}`);
        },
        link: (source, destination) => link(source, destination),
        unlink: (path) => unlink(path),
      };

      const pending = writeOperatorOutput(request(kind, input, out), {
        stdout: stdout.stream,
        stderr: stderr.stream,
        fs: fileSystem,
      });

      await expect(pending).rejects.toBeInstanceOf(OperatorError);
      await expect(pending).rejects.toThrow(/injected write failure/iu);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe("");
      expect(await readFile(input)).toEqual(ORIGINAL_INPUT);
      expect(await readdir(directory)).toEqual([`${kind}-input.json`]);
    },
  );

  test("a destination created between the probe and publish wins the race and is never overwritten", async () => {
    const input = join(directory, "input.json");
    const out = join(directory, "raced.json");
    const racedBytes = Buffer.from("another writer owns this destination\n");
    await writeFile(input, ORIGINAL_INPUT);
    const stdout = capturedStream();
    const stderr = capturedStream();
    const fileSystem: OperatorOutputFileSystem = {
      lstat: (path) => lstat(path),
      writeFile: (path, artifact) => writeFile(path, artifact, { encoding: "utf8", flag: "wx" }),
      link: async (source, destination) => {
        await writeFile(destination, racedBytes, { flag: "wx" });
        await link(source, destination);
      },
      unlink: (path) => unlink(path),
    };

    const pending = writeOperatorOutput(request("update", input, out), {
      stdout: stdout.stream,
      stderr: stderr.stream,
      fs: fileSystem,
    });

    await expect(pending).rejects.toBeInstanceOf(OperatorError);
    await expect(pending).rejects.toThrow(/already exists/iu);
    expect(await readFile(out)).toEqual(racedBytes);
    expect(await readFile(input)).toEqual(ORIGINAL_INPUT);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
    expect((await readdir(directory)).sort()).toEqual(["input.json", "raced.json"]);
  });
});
