/**
 * A write that created its record and then failed before it could return.
 *
 * `toInstanceWriteStep` records an instance's receipt only after `adapter.write`
 * returns, and a retry turns that receipt into an UPDATE. An adapter whose one
 * `write` is several requests (a create, then a follow-up) has a window where the
 * record exists and the return never happens: no receipt, so the retry creates a
 * second record. Throwing this closes the window. The step records `receipt`, then
 * rethrows `cause` unchanged, so the relay classifies the failure (transient or
 * terminal) exactly as it would have without the wrapper.
 *
 * Throw it only when the receipt names a record that really exists.
 * @category Write-back
 */
export class ReceiptedWriteError extends Error {
  override readonly name: string = "ReceiptedWriteError";

  /** The receipt of the record that landed, as `write` would have returned it. */
  readonly receipt: string;

  constructor(receipt: string, cause: unknown) {
    super(
      `write failed after its record landed (receipt ${receipt}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.receipt = receipt;
  }
}
