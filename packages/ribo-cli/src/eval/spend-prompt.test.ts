/**
 * @file The confirmation, driven without a terminal.
 *
 * The streams are injected, so the suite asks the question, answers it, and
 * closes the input — the three things that can happen on a terminal — without
 * a real one.
 */
import { Readable, Writable } from "node:stream";
import { expect, test } from "vitest";

import { isAffirmative, terminalConfirmation } from "./spend-prompt.js";

/**
 * A readable stream that claims to be a terminal.
 *
 * The `isTTY` flag is the point of the fake: it is what the guard reads to
 * decide whether an operator can be asked at all.
 */
const ttyInput = (text: string) => Object.assign(Readable.from([text]), { isTTY: true });

/** A readable stream that claims to be a terminal and ends at once. */
const ttyInputEnded = () => Object.assign(Readable.from([]), { isTTY: true });

/** A writable stream that claims to be a terminal, and collects what is written. */
const ttyOutput = (): {
  readonly stream: ReturnType<typeof Object.assign<Writable, { isTTY: boolean }>>;
  readonly text: () => string;
} => {
  let written = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written += String(chunk);
      callback();
    },
  });
  return {
    stream: Object.assign(stream, { isTTY: true }),
    text: () => written,
  };
};

test("no terminal means no confirmation at all", () => {
  const input = ttyInput("y\n");
  const output = ttyOutput().stream;

  // A piped output is just as disqualifying as a piped input.
  const pipedOutput = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { isTTY: false },
  );
  expect(terminalConfirmation({ input, output: pipedOutput })).toBeUndefined();

  const pipedInput = Object.assign(Readable.from(["y\n"]), { isTTY: false });
  expect(terminalConfirmation({ input: pipedInput, output })).toBeUndefined();
});

test("an operator who answers y proceeds", async () => {
  const output = ttyOutput();
  const confirmation = terminalConfirmation({ input: ttyInput("y\n"), output: output.stream });
  expect(confirmation).toBeDefined();

  expect(await confirmation?.ask("continue? ")).toBe(true);
  // The question reached the operator's terminal.
  expect(output.text()).toContain("continue?");
});

test("an operator who answers yes proceeds", async () => {
  const confirmation = terminalConfirmation({
    input: ttyInput("YES\n"),
    output: ttyOutput().stream,
  });

  expect(await confirmation?.ask("continue? ")).toBe(true);
});

test("any other answer refuses", async () => {
  for (const answer of ["n\n", "no\n", "maybe\n", "\n"]) {
    const confirmation = terminalConfirmation({
      input: ttyInput(answer),
      output: ttyOutput().stream,
    });
    expect(await confirmation?.ask("continue? ")).toBe(false);
  }
});

test("the end of the input refuses, and does not hang", async () => {
  const confirmation = terminalConfirmation({
    input: ttyInputEnded(),
    output: ttyOutput().stream,
  });

  expect(await confirmation?.ask("continue? ")).toBe(false);
});

test("only y and yes are an assent", () => {
  expect(isAffirmative("y")).toBe(true);
  expect(isAffirmative(" Y ")).toBe(true);
  expect(isAffirmative("yes")).toBe(true);
  expect(isAffirmative("YES")).toBe(true);
  expect(isAffirmative("n")).toBe(false);
  expect(isAffirmative("")).toBe(false);
  expect(isAffirmative("aye")).toBe(false);
});
