import { StructuredError } from "../utils/telemetry.js";

export type FailureStatus =
  "invalid" | "unsupported" | "history-required" | "limit";

/** A failed CEL 3 check, with a machine-readable category and specific code. */
export class CelError extends StructuredError {
  constructor(
    public readonly status: FailureStatus,
    code: string,
    message: string,
  ) {
    super(code, message);
    this.name = "CelError";
  }
}

export function requireThat(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new CelError("invalid", code, message);
}

export function limit(condition: boolean, message: string): void {
  if (!condition) throw new CelError("limit", "CEL_LIMIT", message);
}
