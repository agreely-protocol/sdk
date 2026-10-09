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
  | "body_too_large"
  // Manual and verbal consents, consent sheets, withdrawals and documents.
  | "conflict"
  | "verbal_daily_cap"
  | "withdrawal_daily_cap"
  | "already_minted"
  | "no_consent_ask"
  | "english_text_missing"
  // The customer registry and per-customer retention (scope 'registry'). On these
  // routes the stable string travels in `code`, not in `reason`.
  | "identity_held"
  | "identity_erased"
  | "relationship_active"
  | "already_released"
  | "too_many_holds"
  | "hold_budget_exhausted"
  | "hold_release_cap_reached"
  // Host inventory.
  | "new_set_limit";

/**
 * The STABLE machine reason of a refusal, sent as `error.reason` beside the HTTP-level
 * `code`. Compare it, never the English `message`, which may be reworded.
 *
 * Which routes send one: manual consents (record, claim links, revoke, erase), verbal
 * consents (record, paper, history), consent sheets and the withdrawal route, plus the
 * shared body checks (`missing_field`, `invalid_field`, `invalid_json`,
 * `invalid_idempotency_key`) on those routes. The customer registry, retention holds,
 * dispositions and inventory refusals carry their stable string in `code` instead
 * (for example `identity_held`, `already_released`, `hold_release_cap_reached`).
 *
 * The same reason can travel with different statuses: `relationship_ended` is a 409 on
 * a manual or verbal record and on a claim link; `daily_cap` is the verbal cap (code
 * `verbal_daily_cap`) or the withdrawal cap (code `withdrawal_daily_cap`).
 *
 * OPEN-ENDED ON PURPOSE: the server adds reasons, so the type accepts any string while
 * still autocompleting the known ones. Treat an unknown reason by its HTTP status.
 */
export type AgreelyErrorReason =
  // Shared body checks.
  | "missing_field"
  | "invalid_field"
  | "invalid_json"
  | "invalid_idempotency_key"
  // A customer or a consent that does not resolve for this key.
  | "unknown_customer"
  | "unknown_consent"
  | "not_found"
  // Documents and evidence.
  | "invalid_document"
  | "document_placeholder"
  | "notice_only"
  | "no_items"
  | "invalid_items"
  | "invalid_customer_id"
  | "invalid_pdf_hash"
  | "pdf_hash_mismatch"
  | "pdf_not_pdf"
  | "pdf_empty"
  | "no_verified_domain"
  | "version_attestation_required"
  | "sensitive_express_required"
  | "capacity_declaration_required"
  | "capacity_verification_invalid"
  // Dates.
  | "invalid_effective_date"
  | "effective_date_in_future"
  | "invalid_valid_until"
  | "valid_until_too_far"
  | "valid_until_in_past"
  | "invalid_obtained_at"
  | "obtained_at_in_future"
  | "invalid_signed_at"
  | "signed_at_in_future"
  // The state of the record.
  | "stronger_consent_active"
  | "all_covered"
  | "relationship_ended"
  | "verbal_awaits_paper"
  | "superseded_by_paper"
  | "citizen_consent_at_gate"
  | "renewal_ends_before_current"
  | "renewal_predates_current"
  | "predates_withdrawal"
  | "consent_lapsed"
  | "not_revocable"
  | "lapsed"
  | "already_confirmed"
  | "nothing_to_confirm"
  | "stale_form"
  // Verbal answers and respondent.
  | "invalid_answers"
  | "duplicate_answer"
  | "informed_line_answered"
  | "nothing_consented"
  | "invalid_obtained_by"
  | "invalid_script_version"
  | "invalid_respondent"
  | "minor_needs_guardian"
  | "paper_purpose_not_consented_by_phone"
  | "paper_answer_missing"
  // Withdrawal.
  | "invalid_channel"
  | "invalid_operator"
  | "requested_at_invalid"
  | "requested_at_in_future"
  | "requested_at_before_grant"
  | "invalid_reason"
  // Caps and claims.
  | "daily_cap"
  | "claim_link_already_live"
  | "already_minted"
  | "body_too_large"
  | "unknown_field"
  // Any reason this SDK version does not know yet.
  | (string & Record<never, never>);

export interface AgreelyErrorInit {
  code: AgreelyErrorCode;
  /** HTTP status, when the error came from a response. */
  status?: number;
  /** The offending input field, when the server named one. */
  field?: string;
  /** The stable machine reason of the refusal, when the server sent one. */
  reason?: AgreelyErrorReason;
  /** The underlying cause (a network error, an abort, etc). */
  cause?: unknown;
}

/** Base class for every error the SDK throws. */
export class AgreelyError extends Error {
  readonly code: AgreelyErrorCode;
  readonly status: number | undefined;
  /** The input field the refusal is about (`error.field`), when the server named one. */
  readonly field: string | undefined;
  /**
   * The STABLE machine reason of the refusal (`error.reason`), when the server sent one.
   * Branch on it, never on `message`. Undefined on routes that carry their stable string
   * in `code`, and on errors raised client-side.
   */
  readonly reason: AgreelyErrorReason | undefined;

  constructor(message: string, init: AgreelyErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.code = init.code;
    this.status = init.status;
    this.field = init.field;
    this.reason = init.reason;
  }
}

/** 401 unauthorized OR 403 forbidden: the key is missing, invalid, revoked, or lacks the scope. */
export class AgreelyAuthError extends AgreelyError {}

/** 400 / 422: malformed or invalid input. `field` names the offending input when known. */
export class AgreelyValidationError extends AgreelyError {}

/** 404: no such resource. */
export class AgreelyNotFoundError extends AgreelyError {}

/**
 * 402: the company behind the API key has an inactive/lapsed subscription
 * (trial ended unpaid, past_due, or canceled). DISTINCT from an outage: NOT
 * transient and NOT retryable. Treat it as fail-closed for gating (do NOT grant
 * a gated value) but surface it as actionable, the company must pay to restore
 * service, it is not "Agreely is down".
 */
export class AgreelyBillingInactiveError extends AgreelyError {}

/** 429: the per-company rate window was exceeded. */
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
 * 429 on a per-company DAILY cap, not the per-minute window. `code` names which one:
 *
 *   - `verbal_daily_cap`: verbal (telephone) consents recorded today (also thrown as
 *     the narrower {@link AgreelyVerbalDailyCapError});
 *   - `withdrawal_daily_cap`: withdrawals recorded through the API in 24 hours. It
 *     sends no Retry-After: it is a tripwire for a runaway or stolen key, and the
 *     owner is notified. Record further withdrawals from the customer page in Agreely;
 *   - `hold_budget_exhausted`: retention holds placed through the API in 24 hours;
 *   - `hold_release_cap_reached`: holds the API did NOT place, released through the
 *     API in 24 hours. The organisation releases further ones in Agreely.
 *
 * A subclass of AgreelyRateLimitError, so a generic rate-limit catch still catches it.
 * The SDK never auto-retries it: waiting out a per-minute window cannot help.
 */
export class AgreelyDailyCapError extends AgreelyRateLimitError {}

/**
 * 429 `verbal_daily_cap`: the organisation reached its daily limit of verbal
 * (telephone) consents. A subclass of AgreelyDailyCapError (and so of
 * AgreelyRateLimitError). The SDK never auto-retries it, and retrying today will not
 * succeed.
 */
export class AgreelyVerbalDailyCapError extends AgreelyDailyCapError {}

/**
 * 409. Branch on `code`, the two meanings are opposite:
 *
 *   - `retry`: a concurrent retry of the same declaration could not be settled.
 *     Nothing new was recorded under this attempt. Retry with the SAME
 *     Idempotency-Key (and, after a key rotation, the SAME API key): that replays
 *     the declaration rather than recording a second one.
 *   - `conflict`: the request contradicts the record's current state, and retrying
 *     it unchanged will fail again. Examples: a purpose already held by an active
 *     stronger consent (or already covered), a customer relationship that has ended,
 *     a second paper for the same verbal consent, a manual consent for a customer and
 *     document whose verbal consent still awaits its paper, or withdrawing a verbal
 *     consentRef whose paper already came back (withdraw the manual one instead).
 *     Nothing was recorded. Read `reason` for which state refused it.
 *   - `already_minted`: this Idempotency-Key already produced a consent sheet. Its
 *     printed reference and claim link were returned once and are not kept.
 *   - `identity_held` / `identity_erased` (the customer registry), `relationship_active`
 *     (a disposition before the relationship ended), `already_released` (a hold).
 *
 * Not an outage and not a rate limit.
 */
export class AgreelyConflictError extends AgreelyError {}

/**
 * The client-side poll budget (e.g. waitForSettlement) elapsed before the
 * resource reached a terminal state. NOT a server outage, the last-seen state
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
 * 503 / network error / timeout: Agreely was unreachable. This is the ONLY
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
