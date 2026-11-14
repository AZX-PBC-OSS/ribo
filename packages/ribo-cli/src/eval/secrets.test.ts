/**
 * @file Where a secret comes from: the environment, or the working
 * directory's `.env.local`.
 *
 * Every part of the reader is injected, so the suite never reads a real file
 * and never reads the developer's own environment.
 */
import { expect, test } from "vitest";

import { lookupSecret, parseEnvLocal } from "./secrets.js";

/** A reader that answers from a map, so no file is touched. */
const readerOf =
  (files: Readonly<Record<string, string>>) =>
  (file: string): string | undefined =>
    files[file];

test("the environment wins over the file", () => {
  const lookup = lookupSecret("OPENAI_API_KEY", {
    env: { OPENAI_API_KEY: "env-key" },
    cwd: "/tmp/nowhere",
    readFileImpl: readerOf({ "/tmp/nowhere/.env.local": "OPENAI_API_KEY=file-key\n" }),
  });

  expect(lookup.value).toBe("env-key");
  expect(lookup.origin).toBe("environment");
});

test("the file is used when the environment holds no value", () => {
  const lookup = lookupSecret("OPENAI_API_KEY", {
    env: {},
    cwd: "/tmp/nowhere",
    readFileImpl: readerOf({ "/tmp/nowhere/.env.local": "OPENAI_API_KEY=file-key\n" }),
  });

  expect(lookup.value).toBe("file-key");
  expect(lookup.origin).toBe("file");
});

test("an empty environment value counts as missing", () => {
  const lookup = lookupSecret("OPENAI_API_KEY", {
    env: { OPENAI_API_KEY: "" },
    cwd: "/tmp/nowhere",
    readFileImpl: readerOf({ "/tmp/nowhere/.env.local": "OPENAI_API_KEY=file-key\n" }),
  });

  expect(lookup.value).toBe("file-key");
  expect(lookup.origin).toBe("file");
});

test("a missing key reports the file it checked, by its absolute path", () => {
  const lookup = lookupSecret("OPENAI_API_KEY", {
    env: {},
    cwd: "/tmp/nowhere",
    readFileImpl: readerOf({}),
  });

  expect(lookup.value).toBeUndefined();
  expect(lookup.origin).toBeUndefined();
  expect(lookup.filePath).toBe("/tmp/nowhere/.env.local");
});

test("the file's dialect is minimal: comments, blanks and the first equals sign", () => {
  const entries = parseEnvLocal(
    ["# a comment", "", "OPENAI_API_KEY=sk-123", "OTHER = spaced ", "EMPTY="].join("\n"),
  );

  expect(entries["OPENAI_API_KEY"]).toBe("sk-123");
  expect(entries["OTHER"]).toBe("spaced");
  expect(entries["EMPTY"]).toBe("");
});

test("no quoting is honoured, so a quoted value keeps its quotes", () => {
  const entries = parseEnvLocal('OPENAI_API_KEY="sk-123"');

  expect(entries["OPENAI_API_KEY"]).toBe('"sk-123"');
});
