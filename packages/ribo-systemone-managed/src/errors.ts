import { TerminalError } from "@azx/ribo-core";

/**
 * A System One request that can never succeed: 401 (invalid credential) or 422
 * (request validation failed).
 *
 * Extends {@link TerminalError} DELIBERATELY. In an arbitration ladder the two
 * failure kinds are treated in opposite ways — a terminal error means "this
 * rung is wrong for the request, try the next one", a transient one means "the
 * transport is down, the next rung shares it". A 401 or 422 is a property of
 * the request, so the ladder must fall through; classified transient instead,
 * a detector becomes a full-price retry loop against the same dead request
 * (see `validate-extractor.ts`'s file header for the sibling case). 429, 529
 * and network-level failures are thrown as plain transient errors instead.
 */
export class SystemOneError extends TerminalError {
  override readonly name = "SystemOneError";

  /** The HTTP status the API answered with — 401 or 422. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
