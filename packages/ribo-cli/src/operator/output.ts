/**
 * @file Non-destructive artifact output shared by operator authoring commands.
 *
 * An update never writes its input. A named destination must be distinct and
 * new: the complete artifact is staged beside it and published with a hard
 * link, whose no-clobber behavior also closes the probe/publish race. Review
 * text is emitted only after the artifact reaches its selected destination.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { OperatorError } from "./error.js";

/** The minimal text-stream seam used by the command's two output channels. */
export interface OperatorOutputStream {
  readonly write: (text: string) => unknown;
}

/** Filesystem operations are injectable so partial-write cleanup is testable. */
export interface OperatorOutputFileSystem {
  readonly lstat: (path: string) => Promise<unknown>;
  readonly writeFile: (path: string, artifact: string) => Promise<void>;
  readonly link: (source: string, destination: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

interface OperatorOutputBase {
  /** The complete serialized artifact, including any intended final newline. */
  readonly artifact: string;
  /** Human review or diagnostic text; never mixed into artifact stdout. */
  readonly review?: string;
  /** A distinct new file. Absence selects artifact-only stdout. */
  readonly out?: string;
}

/** Creation has no input path and therefore no in-place form. */
export interface CreateOperatorOutputRequest extends OperatorOutputBase {
  readonly kind: "create";
}

/** Update carries its input solely to reject an in-place destination. */
export interface UpdateOperatorOutputRequest extends OperatorOutputBase {
  readonly kind: "update";
  readonly input: string;
}

/** The create/update forms shared by the authoring commands. */
export type OperatorOutputRequest = CreateOperatorOutputRequest | UpdateOperatorOutputRequest;

/** Where the complete artifact was successfully emitted. */
export type OperatorOutputResult =
  { readonly destination: "stdout" } | { readonly destination: "file"; readonly path: string };

/** Injectable process and filesystem dependencies; no backend is involved. */
export interface WriteOperatorOutputOptions {
  readonly cwd?: string;
  readonly stdout?: OperatorOutputStream;
  readonly stderr?: OperatorOutputStream;
  readonly fs?: OperatorOutputFileSystem;
}

const defaultFileSystem: OperatorOutputFileSystem = {
  lstat: (path) => lstat(path),
  writeFile: (path, artifact) => writeFile(path, artifact, { encoding: "utf8", flag: "wx" }),
  link: (source, destination) => link(source, destination),
  unlink: (path) => unlink(path),
};

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === code;

const destinationAdvice =
  "(fix: choose a distinct new --out path, or omit --out to write the artifact to stdout)";

const existingDestinationError = (destination: string): OperatorError =>
  new OperatorError(
    `the output destination "${destination}" already exists — refusing to overwrite it ` +
      destinationAdvice,
  );

async function probeDestination(fs: OperatorOutputFileSystem, destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw new OperatorError(
      `could not inspect the output destination "${destination}": ${faultMessage(error)} ` +
        destinationAdvice,
    );
  }
  throw existingDestinationError(destination);
}

async function removeStaging(fs: OperatorOutputFileSystem, staging: string): Promise<void> {
  try {
    await fs.unlink(staging);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function commitNewFile(
  fs: OperatorOutputFileSystem,
  destination: string,
  artifact: string,
): Promise<void> {
  const staging = join(dirname(destination), `.${basename(destination)}.ribo-${randomUUID()}.tmp`);

  try {
    await fs.writeFile(staging, artifact);
    // A same-directory hard link publishes the complete file atomically and,
    // unlike rename, cannot replace a destination created after our probe.
    await fs.link(staging, destination);
  } catch (error) {
    try {
      await removeStaging(fs, staging);
    } catch (cleanupError) {
      throw new OperatorError(
        `could not write the artifact to "${destination}": ${faultMessage(error)}; ` +
          `also could not remove the staged file "${staging}": ${faultMessage(cleanupError)} ` +
          destinationAdvice,
      );
    }
    if (hasCode(error, "EEXIST")) throw existingDestinationError(destination);
    throw new OperatorError(
      `could not write the artifact to "${destination}": ${faultMessage(error)} ` +
        destinationAdvice,
    );
  }

  try {
    await removeStaging(fs, staging);
  } catch (error) {
    throw new OperatorError(
      `the artifact was committed to "${destination}", but its staged file "${staging}" ` +
        `could not be removed: ${faultMessage(error)} (fix: remove that staged file)`,
    );
  }
}

function emit(stream: OperatorOutputStream, text: string, channel: string): void {
  try {
    stream.write(text);
  } catch (error) {
    throw new OperatorError(`could not write ${channel}: ${faultMessage(error)}`);
  }
}

/**
 * Refuse an existing `--out` before any paid work. The write still publishes with
 * no-clobber semantics, so a destination created after this probe is never replaced.
 */
export async function assertOperatorOutputIsNew(
  out: string,
  options: Pick<WriteOperatorOutputOptions, "cwd" | "fs"> = {},
): Promise<void> {
  await probeDestination(
    options.fs ?? defaultFileSystem,
    resolve(options.cwd ?? process.cwd(), out),
  );
}

/**
 * Emit an authoring artifact without modifying an input or replacing a file.
 * Refusals and staged-write faults are shared {@link OperatorError}s and occur
 * before either artifact or review text is emitted.
 */
export async function writeOperatorOutput(
  request: OperatorOutputRequest,
  options: WriteOperatorOutputOptions = {},
): Promise<OperatorOutputResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (request.out === undefined) {
    emit(stdout, request.artifact, "the artifact to stdout");
    if (request.review !== undefined && request.review.length > 0) {
      emit(stderr, request.review, "review text to stderr");
    }
    return { destination: "stdout" };
  }

  const cwd = options.cwd ?? process.cwd();
  const destination = resolve(cwd, request.out);
  if (request.kind === "update" && resolve(cwd, request.input) === destination) {
    throw new OperatorError(
      `the update input and output are the same file "${destination}" — input is never used ` +
        `as output ${destinationAdvice}`,
    );
  }

  const fs = options.fs ?? defaultFileSystem;
  await probeDestination(fs, destination);
  await commitNewFile(fs, destination, request.artifact);
  if (request.review !== undefined && request.review.length > 0) {
    emit(stderr, request.review, "review text to stderr");
  }
  return { destination: "file", path: destination };
}
