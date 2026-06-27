// Typed errors. Every failure the SDK raises is an AgreelyError subclass, so an
// integrator can `catch (e) { if (e instanceof AgreelyRateLimitError) ... }`.
// A consent DENY is NOT an error (it is a 200) and never appears here.

/** The canonical wire error code. */
export type AgreelyErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "config";

export interface AgreelyErrorInit {
  code: AgreelyErrorCode;
  /** HTTP status, when the error came from a response. */
  status?: number;
  /** The offending input field, for validation errors. */
  field?: string;
  /** The underlying cause (a network error, an abort, etc). */
  cause?: unknown;
}

/** Base class for every error the SDK throws. */
export class AgreelyError extends Error {
  readonly code: AgreelyErrorCode;
  readonly status: number | undefined;
  readonly field: string | undefined;

  constructor(message: string, init: AgreelyErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.code = init.code;
    this.status = init.status;
    this.field = init.field;
  }
}

/** 401 unauthorized OR 403 forbidden — the key is missing, invalid, revoked, or lacks the scope. */
export class AgreelyAuthError extends AgreelyError {}

/** 400 / 422 — malformed or invalid input. `field` names the offending input when known. */
export class AgreelyValidationError extends AgreelyError {}

/** 404 — no such resource. */
export class AgreelyNotFoundError extends AgreelyError {}

/** 429 — the per-company rate window was exceeded. */
export class AgreelyRateLimitError extends AgreelyError {
  /** Seconds until the window resets (from the Retry-After header), when given. */
  readonly retryAfter: number | undefined;

  constructor(message: string, init: AgreelyErrorInit & { retryAfter?: number }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/**
 * 503 / network error / timeout — Agreely was unreachable. This is the ONLY
 * error subject to the degrade policy. `retryable` marks the transient cases
 * (503, network, timeout) the transport may retry for idempotent calls.
 */
export class AgreelyUnavailableError extends AgreelyError {
  readonly retryable: boolean;

  constructor(message: string, init: Omit<AgreelyErrorInit, "code"> & { retryable?: boolean }) {
    super(message, { ...init, code: "unavailable" });
    this.retryable = init.retryable ?? false;
  }
}

/** A misconfiguration caught at construction time (e.g. fail-open without onDegrade). */
export class AgreelyConfigError extends AgreelyError {
  constructor(message: string) {
    super(message, { code: "config" });
  }
}
