/**
 * @file The shared fault for operator commands that cannot start or proceed.
 *
 * Command-specific adapters may narrow this class, but the bin's existing
 * `SchemaInspectError` mapping remains the one exit-code discipline.
 */
import { SchemaInspectError } from "../inspect/error.js";

/** An operator-facing refusal, before or instead of the requested work. */
export class OperatorError extends SchemaInspectError {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}
