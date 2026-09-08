/**
 * Error taxonomy.
 *
 * Each error carries a stable machine-readable `code` and a CLI `exitCode`, so
 * that both programs and AI agents can tell apart "AliExpress blocked us" from
 * "AliExpress changed its payload shape". Those two failures need completely
 * different responses, and collapsing them into a generic error is the main way
 * a scraper-backed tool becomes undebuggable.
 */

export type AliErrorCode =
  | "VALIDATION"
  | "BLOCKED"
  | "UPSTREAM"
  | "SCHEMA_DRIFT"
  | "NOT_FOUND"
  | "NETWORK";

/** Process exit codes used by the CLI. Part of the public contract. */
export const EXIT_CODES = {
  OK: 0,
  GENERAL: 1,
  VALIDATION: 2,
  BLOCKED: 3,
  SCHEMA_DRIFT: 4,
} as const;

export class AliError extends Error {
  readonly code: AliErrorCode;
  readonly hint: string | undefined;
  readonly detail: unknown;

  constructor(
    code: AliErrorCode,
    message: string,
    options: { hint?: string; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = options.hint;
    this.detail = options.detail;
  }

  /** Exit code the CLI should use for this error. */
  get exitCode(): number {
    switch (this.code) {
      case "VALIDATION":
        return EXIT_CODES.VALIDATION;
      case "BLOCKED":
        return EXIT_CODES.BLOCKED;
      case "SCHEMA_DRIFT":
        return EXIT_CODES.SCHEMA_DRIFT;
      default:
        return EXIT_CODES.GENERAL;
    }
  }

  toJSON(): { error: { code: string; message: string; hint?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
      },
    };
  }
}

/** Bad arguments. Raised before any network call. */
export class AliValidationError extends AliError {
  constructor(message: string, hint?: string) {
    super("VALIDATION", message, { hint });
  }
}

/** Anti-bot challenge, rate limit, or an outright refusal from AliExpress. */
export class AliBlockedError extends AliError {
  constructor(message: string, detail?: unknown, hint?: string) {
    super("BLOCKED", message, {
      hint: hint ??
        "Slow down, change egress IP, or retry later. This is not a bug in the parser.",
      detail,
    });
  }
}

/** AliExpress answered, but with an error of its own. */
export class AliUpstreamError extends AliError {
  constructor(message: string, detail?: unknown) {
    super("UPSTREAM", message, { detail });
  }
}

/**
 * The response arrived and looked healthy, but a field this library depends on
 * was missing. This almost always means AliExpress changed its payload.
 */
export class AliSchemaError extends AliError {
  constructor(message: string, detail?: unknown) {
    super("SCHEMA_DRIFT", message, {
      hint: "AliExpress likely changed its response shape. The normalizer needs updating.",
      detail,
    });
  }
}

export class AliNotFoundError extends AliError {
  constructor(message: string) {
    super("NOT_FOUND", message);
  }
}
