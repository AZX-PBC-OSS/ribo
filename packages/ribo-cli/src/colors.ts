import { createColors } from "picocolors";

export type Colors = ReturnType<typeof createColors>;

/**
 * Colour only on a terminal, never under a non-empty `NO_COLOR`. picocolors'
 * own detection also colours whenever `CI` is set, which put escape bytes in
 * piped output on CI runners.
 */
export const colorsFor = (
  stream: { readonly isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Colors => createColors(stream.isTTY === true && !env.NO_COLOR);
