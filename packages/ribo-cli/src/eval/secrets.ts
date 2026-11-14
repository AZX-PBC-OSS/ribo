/**
 * @file Where a secret comes from: the environment, or the working
 * directory's `.env.local`.
 *
 * A secret never rides a flag (the CLI's own rule), so the credential comes
 * from one of two places: the process environment, or a `.env.local` file in
 * the caller's working directory. The file is gitignored (`.gitignore`'s
 * `*.local` line), so it is never committed, and it is read ONLY when it
 * exists — the reader never creates it.
 *
 * The environment wins: an operator who exports a key overrides the file
 * without editing it, which is what makes the file safe to leave lying around.
 *
 * The file's format is deliberately minimal — `KEY=VALUE` lines, blank lines
 * and `#` comments skipped, no quoting, no `export`, no expansion — because a
 * half-implemented dotenv dialect is a source of silent surprises. The reader
 * is plain `node:fs`; the package takes no new runtime dependency for it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Where a secret was found.
 */
export type SecretOrigin = "environment" | "file";

/**
 * The result of looking a secret up.
 */
export interface SecretLookup {
  /** The key that was looked up. */
  readonly key: string;
  /** The value, when one was found. Absent means "not set anywhere". */
  readonly value?: string;
  /** Where the value came from. Absent when no value was found. */
  readonly origin?: SecretOrigin;
  /** The absolute path of the `.env.local` the reader checked. */
  readonly filePath: string;
}

/**
 * The reader's injectable parts.
 *
 * Every part is injectable, so a test never reads a real file and never reads
 * the developer's own environment.
 */
export interface SecretLookupOptions {
  /** The environment to read. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The working directory whose `.env.local` is read. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Read a file's text. Returns `undefined` when the file does not exist.
   * Defaults to reading it off disk.
   */
  readonly readFileImpl?: (file: string) => string | undefined;
}

/** The name of the file the reader looks for, in the working directory. */
export const ENV_LOCAL_FILE = ".env.local";

/**
 * Read a file's text, or report that it is not there.
 *
 * A file that exists but cannot be read is reported as "not there" — the
 * reader's job is to find a secret, and an unreadable `.env.local` is a
 * missing secret, which the caller reports with its own fix.
 */
const readFileOrMissing = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Parse a `.env.local` file's text into its entries.
 *
 * The dialect is minimal and documented: a `KEY=VALUE` line, a blank line or
 * a `#` comment is skipped, and the value is everything after the first `=`,
 * trimmed. No quoting is honoured — a quoted value keeps its quotes, which is
 * visible rather than silently stripped.
 * @param text - The file's text.
 * @returns The entries, by key.
 */
export function parseEnvLocal(text: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key.length === 0) continue;
    entries[key] = value;
  }
  return entries;
}

/**
 * Look a secret up: the environment first, then the working directory's
 * `.env.local`.
 *
 * An empty value counts as missing — an exported-but-empty variable is not a
 * credential, and treating it as one would fail later, at the endpoint, with a
 * far worse diagnostic.
 * @param key - The environment variable's name.
 * @param options - The injectable environment, working directory and reader.
 * @returns The lookup: the value when one was found, and the file that was checked either way.
 */
export function lookupSecret(key: string, options: SecretLookupOptions = {}): SecretLookup {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const filePath = path.resolve(cwd, ENV_LOCAL_FILE);

  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { key, value: fromEnv, origin: "environment", filePath };
  }

  const read = options.readFileImpl ?? readFileOrMissing;
  const text = read(filePath);
  if (text !== undefined) {
    const value = parseEnvLocal(text)[key];
    if (value !== undefined && value.length > 0) {
      return { key, value, origin: "file", filePath };
    }
  }

  return { key, filePath };
}
