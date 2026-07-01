// The wire types of the Agreely /v1 API, mirrored 1:1 from the committed
// openapi.yaml. These shapes are load-bearing (anti-drift, like the Phase-2
// crypto vectors): the contract tests assert real responses against them.

/** A consent decision. ALLOW is the only true. */
export type Decision = "allow" | "deny";

/**
 * A /v1 API-key scope: 'check' (the synchronous check), 'issue' (consent-request
 * issuance + reads), 'attest' (manual / offline consent recording).
 */
export type Scope = "check" | "issue" | "attest";

/**
 * The least-disclosure identity of the presented key, from GET /v1/whoami. The
 * WIRE response carries ONLY the key's own scopes — no company id, no key name,
 * no counters, no PII. `baseUrl` is added CLIENT-SIDE (the configured endpoint),
 * never part of the wire body.
 */
export interface Identity {
  /** The presented key's scopes, exactly as the server reports them. */
  scopes: Scope[];
}

/**
 * How an enforcement record was established:
 *   "citizen_signed"   -> the subject signed it themselves (the live consent flow)
 *   "company_attested" -> the company recorded it offline (the manual / offline path)
 * Present on a check whenever an enforcement record exists; absent for status "none".
 */
export type Assurance = "citizen_signed" | "company_attested";

/**
 * The resolved status of an enforcement cell.
 *
 *   "active"  -> allow
 *   "none"    -> deny (no record; consentRef is ABSENT)
 *   "revoked" / "expired" / "erased" -> deny
 *
 * The handoff names active/revoked/expired/none; "erased" is also a server-side
 * deny status in the contract, so it is included to stay faithful to openapi.yaml.
 */
export type Status = "active" | "none" | "revoked" | "expired" | "erased";

/** The full result of a check. `check()` returns the boolean; this is the reasoned form. */
export interface CheckResult {
  decision: Decision;
  status: Status;
  /** 0x-hex enforcement handle. Present for every status EXCEPT "none". */
  consentRef?: string;
  /** ISO-8601 timestamp the decision was made at. */
  checkedAt: string;
  /**
   * How the enforcement record was established (citizen-signed vs company-
   * attested). Present whenever an enforcement record exists; absent for status
   * "none" and never set on a degraded (synthesized) result.
   */
  assurance?: Assurance;
  /**
   * True when this result did NOT come from the server but from the local
   * degrade policy (fail-open / break-glass) during an outage. Never set on a
   * real server decision.
   */
  degraded?: boolean;
  /** The degrade mode that produced a degraded allow, when `degraded` is true. */
  mode?: DegradeMode;
}

/** One (category, purpose) label pair, as the server echoes it back. */
export interface ItemLabels {
  category: string;
  purpose: string;
}

/**
 * An item to request consent for: either a catalog entry id (string) OR a raw
 * {category, purpose} pair. Pairs are resolved server-side to the company's
 * declared active catalog — the SDK sends them raw and NEVER normalizes.
 */
export type IssueItem = string | { category: string; purpose: string };

/**
 * Input for issuing a consent request. Every request is issued under a
 * PUBLISHED consent document (the Law 25 s. 8 disclosure): exactly ONE of
 * `consentDocumentId` / `documentCode` is required. The requested (category,
 * purpose) items derive from the document server-side — there is no caller
 * items list.
 */
export interface CreateConsentRequestInput {
  customerId: string;
  recipientEmail: string;
  /** The published consent document VERSION id to issue under. */
  consentDocumentId?: string;
  /** A document code; the server resolves the currently-published version. */
  documentCode?: string;
  /** The consent lifespan if approved (a future date/time, ISO-8601). */
  validUntil: string;
}

/**
 * The bound consent document snapshot (code, name, version) the signed offer
 * commits to.
 */
export interface ConsentDocumentDescriptor {
  code: string;
  name: string;
  version: string;
}

/** The 201 body from issuance (or an idempotent replay of it). */
export interface IssuedRequest {
  /** The protocol handle (0x-prefixed 64-hex). The public identifier. */
  requestId: string;
  status: "pending";
  /** The recipient's secure approval link. */
  deepLink: string;
  emailDelivered: boolean;
  items: ItemLabels[];
  /** The published consent document the request was issued under. */
  document: ConsentDocumentDescriptor;
}

export type ConsentRequestStatus =
  | "pending"
  | "approved"
  | "refused"
  | "expired"
  | "revoked_before_action";

/** A consent request record as returned by list/get. */
export interface ConsentRequestRecord {
  /** The protocol requestId (0x-prefixed 64-hex), NOT an internal uuid. */
  requestId: string;
  status: ConsentRequestStatus;
  validUntil: string;
  expiresAt: string;
  createdAt: string;
  settledAt: string | null;
  items: ItemLabels[];
  /** Null only on legacy rows issued before the document became mandatory. */
  document: ConsentDocumentDescriptor | null;
}

/**
 * The 200 body from POST /v1/consent-requests/{id}/cancel. `cancelled` is true
 * only when THIS call flipped a pending request to revoked_before_action; false
 * on an idempotent no-op against an already-terminal request (not an error).
 * `status` is the request's status AFTER the call.
 */
export interface CancelledRequest {
  /** The protocol requestId (0x-prefixed 64-hex). */
  requestId: string;
  status: ConsentRequestStatus;
  cancelled: boolean;
}

export interface ListConsentRequestsInput {
  status?: ConsentRequestStatus;
  /** The requestId to page after (from a prior `nextCursor`). */
  cursor?: string;
}

/** Options for the auto-paginating listAll/collect. */
export interface ListAllConsentRequestsInput {
  status?: ConsentRequestStatus;
  /** Start paging after this requestId (a prior `nextCursor`). */
  cursor?: string;
  /** Hard guard on pages fetched (default 1000) so a runaway cursor can't spin forever. */
  maxPages?: number;
}

/** Options for waitForSettlement. */
export interface WaitForSettlementOptions {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** Total wait budget in ms before AgreelyTimeoutError. Default 120000. */
  timeoutMs?: number;
  /** Abort the wait (throws AgreelyTimeoutError with the last-seen status). */
  signal?: AbortSignal;
}

/**
 * A page of consent requests. Note the SDK surfaces `items` (the server wire
 * field is `requests`); `nextCursor` is null when the list is exhausted.
 */
export interface ConsentRequestPage {
  items: ConsentRequestRecord[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Manual / offline (company-attested) consent. The company records a consent it
// gathered out of band (a signed paper/PDF), attesting to it under its own name.
// The result carries assurance "company_attested" (vs the citizen-signed path).
// ---------------------------------------------------------------------------

/**
 * The evidence for a manual consent. `pdfSha256` is ALWAYS sent (the integrity
 * commitment, "0x" + 64 lowercase hex of the source PDF). `pdf` is an OPTIONAL
 * opt-in upload of the document bytes (base64); omit it to keep the file local
 * and commit only to its hash (data minimization).
 */
export interface ManualConsentEvidence {
  /** "0x" + 64 hex SHA-256 of the source PDF. Required. */
  pdfSha256: string;
  /** Optional base64 of the PDF bytes (opt-in upload). Omit to stay minimal. */
  pdf?: string;
}

export interface RecordManualConsentInput {
  customerId: string;
  /** The id of the signed document version the consent attests to. */
  documentVersionId: string;
  /** When the consent took effect (ISO date, e.g. the signature date). */
  effectiveDate: string;
  /** The consent lifespan (ISO date). */
  validUntil: string;
  /** Catalog entry ids and/or {category, purpose} pairs. At least one. */
  items: IssueItem[];
  evidence: ManualConsentEvidence;
}

/** The 201 body from recording a manual consent. */
export interface ManualConsentResult {
  /** The internal consent id for the recorded attestation. */
  consentId: string;
  /** The merkle root committing to the recorded cells. */
  merkleRoot: string;
  /** One 0x-hex enforcement handle per recorded (category, purpose) cell. */
  consentRefs: string[];
  /** Always "company_attested" for the manual path. */
  assurance: "company_attested";
  /** Whether the attestation is already anchored on-chain (false at record time). */
  anchored: boolean;
}

export interface CreateClaimLinkInput {
  customerId: string;
  /** An optional company-side reference to stamp on the claim. */
  reference?: string;
}

/** A claim link the company hands to the subject to self-claim the attestation. */
export interface ClaimLink {
  claimUrl: string;
  token: string;
  expiresAt: string;
}

/** Options for revoking/erasing a manual consent by its consentRef. */
export interface ManualConsentMutationInput {
  /** An optional operator reason recorded with the mutation. */
  reason?: string;
}

/** The 200 body from revoking a manual consent. */
export interface ManualConsentRevocation {
  consentRef: string;
  revoked: boolean;
  /** True when the consent was already revoked (the call is idempotent). */
  alreadyRevoked: boolean;
}

/** The 200 body from erasing a manual consent. */
export interface ManualConsentErasure {
  consentRef: string;
  erased: boolean;
  /** True when the consent was already erased (the call is idempotent). */
  alreadyErased: boolean;
}

/** A declared active catalog entry, for issuance discovery. */
export interface CatalogEntry {
  id: string;
  category: string;
  purpose: string;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Degrade policy types (the fail-closed default + three-gate exception).
// ---------------------------------------------------------------------------

/** How a degraded allow was authorized. */
export type DegradeMode = "fail-open" | "break-glass";

/** The evidence record emitted for every degraded ALLOW. */
export interface DegradeContext {
  customerId: string;
  category: string;
  purpose: string;
  mode: DegradeMode;
  /** The operator reason, present for a break-glass allow. */
  reason?: string;
  /** True when this allow was authorized by an engaged break-glass. */
  breakGlass: boolean;
  /** The underlying outage error (503 / network / timeout). */
  error: Error;
  /** ISO-8601 timestamp of the degraded allow. */
  at: string;
}

/**
 * Integrator config to opt specific categories into fail-open on an outage.
 * Off by default (the SDK is fail-closed). `onDegrade` is MANDATORY when
 * `mode: "fail-open"` — absent, the constructor throws.
 */
export interface DegradeOnOutageConfig {
  /** The explicit word. Only "fail-open" enables the exception. */
  mode: "fail-open";
  /** ONLY these (operator-declared) categories may ever degrade. */
  categories: string[];
  /** Refuse to keep degrading past this window, e.g. "5m", "30s", "1h". */
  maxOutageWindow: string;
  /** Evidence sink. Called for every degraded allow. Mandatory here. */
  onDegrade: (ctx: DegradeContext) => void;
}

/**
 * An auditable break-glass event.
 *
 *   "engage" / "disengage" / "expire" — lifecycle of the operator lever.
 *   "authorized" — a PER-DECISION record: a single break-glass-authorized allow
 *     that happened during an outage. Emitted for EVERY such allow, regardless of
 *     whether `degradeOnOutage` is configured, so the evidence trail can show
 *     every access allowed inside a break-glass window (not just engage/expire).
 *     Carries the customer/category/purpose/error of the specific decision.
 */
export interface BreakGlassEvent {
  action: "engage" | "disengage" | "expire" | "authorized";
  reason?: string;
  scope?: string[];
  ttl?: string;
  at: string;
  expiresAt?: string;
  /** Present on "authorized": the customer of the allowed decision. */
  customerId?: string;
  /** Present on "authorized": the (raw) category of the allowed decision. */
  category?: string;
  /** Present on "authorized": the (raw) purpose of the allowed decision. */
  purpose?: string;
  /** Present on "authorized": the underlying outage error (503 / network / timeout). */
  error?: Error;
}

export interface BreakGlassEngageInput {
  /** Mandatory. Engaging without a reason throws. */
  reason: string;
  /** Auto-expiry, e.g. "30m". */
  ttl: string;
  /** Categories this break-glass covers. Omit to cover all. */
  scope?: string[];
}

export interface AgreelyOptions {
  /** The Agreely API key (agr_live_...). Required. */
  apiKey: string;
  /** API base URL. Defaults to https://api.agreely.ca. */
  baseUrl?: string;
  /** Per-call total time budget in ms, including retries. Default 800. */
  timeout?: number;
  /** Opt specific categories into fail-open on an outage. Off by default. */
  degradeOnOutage?: DegradeOnOutageConfig;
  /** Audit sink for break-glass engage/disengage/expire AND per-decision authorized allows. */
  onBreakGlass?: (event: BreakGlassEvent) => void;
  /**
   * Upper bound for both a break-glass `ttl` and `degradeOnOutage.maxOutageWindow`.
   * A value like "30m" or "24h". Exceeding it throws AgreelyConfigError (an
   * unbounded fail-open window is a compliance risk). Defaults to "24h".
   */
  maxDegradeWindow?: string;
  /**
   * Inject a fetch implementation (tests / custom transport). Defaults to the
   * global fetch (Node 18+), falling back to a lazily-imported `undici`.
   */
  fetch?: typeof fetch;
  /**
   * Opt-in: how many EXTRA attempts to make on a 429 for IDEMPOTENT calls
   * (GET / check). Default 0 (surface AgreelyRateLimitError immediately, as
   * before). A mutating call is never auto-retried on a 429.
   */
  maxRetries?: number;
  /**
   * When retrying a 429 (see {@link maxRetries}), wait the server's Retry-After
   * header before the next attempt. Default true.
   */
  respectRetryAfter?: boolean;
}

/** Per-call options for check / checkDetailed. */
export interface CheckOptions {
  /**
   * Per-call outage override. "allow" requests a fail-open for THIS call, and
   * is effective ONLY if the category is also in the config allow-list (two
   * gates). "deny" forces fail-closed. Default: the configured behavior.
   */
  onOutage?: "allow" | "deny";
}
