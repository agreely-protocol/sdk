// The wire types of the Agreely /v1 API, mirrored 1:1 from the committed
// openapi.yaml. These shapes are load-bearing (anti-drift, like the Phase-2
// crypto vectors): the contract tests assert real responses against them.

/** A consent decision. ALLOW is the only true. */
export type Decision = "allow" | "deny";

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

export interface CreateConsentRequestInput {
  customerId: string;
  recipientEmail: string;
  /** Catalog entry ids and/or {category, purpose} pairs. At least one. */
  items: IssueItem[];
  /** The consent lifespan if approved (a future date/time, ISO-8601). */
  validUntil: string;
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
}

export interface ListConsentRequestsInput {
  status?: ConsentRequestStatus;
  /** The requestId to page after (from a prior `nextCursor`). */
  cursor?: string;
}

/**
 * A page of consent requests. Note the SDK surfaces `items` (the server wire
 * field is `requests`); `nextCursor` is null when the list is exhausted.
 */
export interface ConsentRequestPage {
  items: ConsentRequestRecord[];
  nextCursor: string | null;
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

/** An auditable break-glass lifecycle event (engage / disengage). */
export interface BreakGlassEvent {
  action: "engage" | "disengage" | "expire";
  reason?: string;
  scope?: string[];
  ttl?: string;
  at: string;
  expiresAt?: string;
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
  /** API base URL. Defaults to https://api.agreely.org. */
  baseUrl?: string;
  /** Per-call total time budget in ms, including retries. Default 800. */
  timeout?: number;
  /** Opt specific categories into fail-open on an outage. Off by default. */
  degradeOnOutage?: DegradeOnOutageConfig;
  /** Audit sink for break-glass engage/disengage/expire. */
  onBreakGlass?: (event: BreakGlassEvent) => void;
  /**
   * Inject a fetch implementation (tests / custom transport). Defaults to the
   * global fetch (Node 18+), falling back to a lazily-imported `undici`.
   */
  fetch?: typeof fetch;
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
