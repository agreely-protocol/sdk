// Typed errors. Every failure the SDK raises is an AgreelyError subclass, so an
// integrator can `catch (e) { if (e instanceof AgreelyRateLimitError) ... }`.
// A consent DENY is NOT an error (it is a 200) and never appears here.

/** The canonical wire error code. */
export type AgreelyErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "billing_inactive"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "config"
  // Host retention and inventory (scopes 'retention' / 'inventory'). A refusal
  // carries one of these as `code`; branch on the code, never on the message.
  | "unknown_field"
  | "idempotency_key_required"
  | "idempotency_key_reused"
  | "retry"
  | "invalid_method"
  | "anonymization_process_required"
  | "invalid_anonymization_process"
  | "invalid_records_affected"
  | "ran_at_in_future"
  | "swept_at_in_future"
  | "invalid_covered_period"
  | "invalid_host_token"
  | "host_token_limit"
  | "sweep_too_frequent"
  | "value_shaped_label"
  | "invalid_key"
  | "duplicate_key"
  | "limit_exceeded"
  | "host_system_limit"
  | "empty_declaration"
  | "body_too_large";

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

/**
 * 402 — the company behind the API key has an inactive/lapsed subscription
 * (trial ended unpaid, past_due, or canceled). DISTINCT from an outage: NOT
 * transient and NOT retryable. Treat it as fail-closed for gating (do NOT grant
 * a gated value) but surface it as actionable — the company must pay to restore
 * service, it is not "Agreely is down".
 */
export class AgreelyBillingInactiveError extends AgreelyError {}

/** 429 — the per-company rate window was exceeded. */
export class AgreelyRateLimitError extends AgreelyError {
  /** Seconds until the window resets (from the Retry-After header), when given. */
  readonly retryAfter: number | undefined;
  /** Alias of {@link retryAfter} with an explicit unit in the name. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, init: AgreelyErrorInit & { retryAfter?: number }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
    this.retryAfterSeconds = init.retryAfter;
  }
}

/**
 * 429 `sweep_too_frequent`: a pass was already declared under this rule FROM THIS
 * hostSystem less than 15 minutes ago. It is the per-(rule, hostSystem) floor,
 * not the company rate window, and two systems sharing a rule never block each
 * other. A subclass of AgreelyRateLimitError, so a generic rate-limit catch still
 * catches it.
 *
 * Do NOT retry it in a loop: the pass you are declaring is already represented by
 * the one declared less than 15 minutes ago. Drop it, or wait `retryAfterSeconds`
 * only if this pass genuinely ran later. The SDK never auto-retries it.
 */
export class AgreelySweepTooFrequentError extends AgreelyRateLimitError {}

/**
 * 409 `retry`: a concurrent retry of the same declaration could not be settled.
 * Nothing new was recorded under this attempt. Retry with the SAME Idempotency-Key
 * (and, after a key rotation, the SAME API key): that replays the declaration
 * rather than recording a second one. Not an outage and not a rate limit.
 */
export class AgreelyConflictError extends AgreelyError {}

/**
 * The client-side poll budget (e.g. waitForSettlement) elapsed before the
 * resource reached a terminal state. NOT a server outage — the last-seen state
 * is attached so a caller can decide whether to keep waiting.
 */
export class AgreelyTimeoutError extends AgreelyError {
  /** The last status observed before the timeout, when known. */
  readonly lastStatus: string | undefined;

  constructor(message: string, init: { lastStatus?: string; cause?: unknown } = {}) {
    super(message, { code: "timeout", ...(init.cause !== undefined ? { cause: init.cause } : {}) });
    this.name = "AgreelyTimeoutError";
    this.lastStatus = init.lastStatus;
  }
}

/**
 * A caller-initiated abort (the AbortSignal fired) stopped a poll loop (e.g.
 * waitForSettlement). DISTINCT from AgreelyTimeoutError (the budget elapsing):
 * an abort is intentional cancellation, not a timeout. The last-seen state is
 * attached so a caller can decide whether to resume.
 */
export class AgreelyAbortError extends AgreelyError {
  /** The last status observed before the abort, when known. */
  readonly lastStatus: string | undefined;

  constructor(message: string, init: { lastStatus?: string; cause?: unknown } = {}) {
    super(message, { code: "aborted", ...(init.cause !== undefined ? { cause: init.cause } : {}) });
    this.name = "AgreelyAbortError";
    this.lastStatus = init.lastStatus;
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
