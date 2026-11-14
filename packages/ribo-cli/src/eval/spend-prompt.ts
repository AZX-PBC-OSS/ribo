/**
 * @file The confirmation, asked on a terminal — and only on a terminal.
 *
 * The question is asked when BOTH the input and the output are terminals. A
 * piped stderr would swallow the question while the command waited on a stdin
 * nobody is feeding, so with no terminal there is no question at all: an
 * over-ceiling run refuses instead of hanging.
 *
 * End of input is not consent. The operator closing the pipe (or pressing
 * Ctrl-D) ends the readline interface, and the question resolves with no
 * answer — the run is refused, never allowed by default.
 *
 * The streams are injected, so the suite drives the whole path — the question,
 * the answer, the end of input — without a real terminal.
 */
import { createInterface } from "node:readline/promises";

import { colorsFor } from "../colors.js";
import type { SpendConfirmation } from "./spend-ceiling.js";

/**
 * The two streams the question travels over.
 */
export interface TerminalStreams {
  /** The stream the answer comes from. */
  readonly input: NodeJS.ReadableStream;
  /** The stream the question is written to. */
  readonly output: NodeJS.WritableStream;
}

/**
 * Is this answer an assent?
 *
 * Only "y" and "yes" are, case-insensitively and with surrounding space
 * ignored. Everything else — including an empty answer — is a refusal.
 * @param answer - What the operator typed.
 * @returns Whether the operator agreed.
 */
export function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/**
 * The confirmation an operator can answer, when there is one to answer.
 *
 * @param streams - The input and output streams, and whether they are terminals.
 * @returns The confirmation, or `undefined` when the streams are not terminals.
 */
export function terminalConfirmation(streams: TerminalStreams): SpendConfirmation | undefined {
  const input = streams.input as NodeJS.ReadableStream & { readonly isTTY?: boolean };
  const output = streams.output as NodeJS.WritableStream & { readonly isTTY?: boolean };
  if (input.isTTY !== true || output.isTTY !== true) return undefined;
  // The question is coloured through the package's one colour wiring, so a
  // terminal run reads like every other diagnostic and a piped one carries no
  // escape bytes.
  const colors = colorsFor(output);
  return {
    ask: async (question: string): Promise<boolean> => {
      const rl = createInterface({ input: streams.input, output: streams.output });
      try {
        // The question and the end of input race: a closed input ends the
        // interface, and an interface that ends leaves the question unsettled.
        // End of input resolves with no answer, which is a refusal.
        const answer = await Promise.race([
          rl.question(colors.yellow(question)),
          new Promise<string>((resolve) => {
            rl.once("close", () => resolve(""));
          }),
        ]);
        return isAffirmative(answer);
      } catch {
        return false;
      } finally {
        rl.close();
      }
    },
  };
}
