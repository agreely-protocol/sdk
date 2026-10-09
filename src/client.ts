import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BreakGlass } from "./breakGlass.js";
import { DegradePolicy } from "./degrade.js";
import { AgreelyBillingInactiveError, AgreelyConfigError, AgreelyUnavailableError } from "./errors.js";
import { Catalog } from "./resources/catalog.js";
import { ConsentDocuments } from "./resources/consentDocuments.js";
import { ConsentRequests } from "./resources/consentRequests.js";
import { Customers } from "./resources/customers.js";
import { Inventory } from "./resources/inventory.js";
import { ManualConsents } from "./resources/manualConsents.js";
import { Relationships } from "./resources/relationships.js";
import { Retention } from "./resources/retention.js";
import { VerbalConsents } from "./resources/verbalConsents.js";
import { Withdrawals } from "./resources/withdrawals.js";
import { Transport } from "./transport.js";
import type { AgreelyOptions, CheckOptions, CheckResult, Identity, BatchCheckItem, BatchDecision, CheckFieldsResult } from "./types.js";
import { DEFAULT_MAX_DEGRADE_WINDOW_MS, parseDuration } from "./util.js";
import { ReceiptVerifier } from "./verify/receipt.js";
import type { ReceiptVerification, VerifyReceiptOptions } from "./verify/types.js";

const DEFAULT_BASE_URL = "https://api.agreely.ca";
const DEFAULT_TIMEOUT_MS = 800;

/**
 * SERVER LIMITS, mirrored here so the SDK can fail fast with a clear client-side
 * error instead of letting you discover them as a 422 / 429 in production.
 *
 * BATCH_CAP: POST /v1/check/batch accepts at most 500 items. Over that the server
 * answers 422 "Batch exceeds the 500-item cap." and decides NOTHING (so a fail-closed
 * caller must treat the whole batch as deny). checkBatch and checkFields both refuse
 * over-cap input BEFORE the wire call.
 */
export const BATCH_CAP = 500;

/**
 * The /v1 tier allows 120 requests per minute PER COMPANY (not per api key), a coarse
 * fixed window. Over it the server answers 429 with a Retry-After header, which this
 * SDK surfaces as AgreelyRateLimitError (and honours on retry when respectRetryAfter
 * is on). It is a deployment default and a self-hosted or negotiated deployment may
 * differ; treat it as the number to design against, not a contract. ONE batch call of
 * 500 cells costs ONE request, which is exactly why checkBatch exists.
 */
export const RATE_LIMIT_PER_MINUTE = 120;

/**
 * The Agreely client: a thin, near-stateless gate over the /v1 API. It holds an
 * api key, a base URL, a fetch client, a timeout, and the degrade policy — NO
 * database, NO ref tables, and NO allow-cache (caching an allow while a revoke
 * lands mid-window is a stale-allow correctness failure). Every
 * check() is a fresh authoritative call.
 */
export class Agreely {
  readonly consentRequests: ConsentRequests;
  /** The published consent documents and their information PDF (scopes: 'check' / 'issue', the PDF also 'attest' / 'attest_verbal'). */
  readonly consentDocuments: ConsentDocuments;
  /** The manual / offline (company-attested) consent resource and consent sheets (scope: 'attest'). */
  readonly manualConsents: ManualConsents;
  /** The verbal (telephone, documented by the organisation) consent resource (scopes: 'attest_verbal' / 'attest'). */
  readonly verbalConsents: VerbalConsents;
  /** Withdrawals recorded on the person's behalf, of any consent ask (scope: 'withdraw', never granted by default). */
  readonly withdrawals: Withdrawals;
  /** The customer registry identity, as metadata (scope: 'registry'). */
  readonly customers: Customers;
  /** The customer-relationship lifecycle resource (scope: 'relationship'). */
  readonly relationships: Relationships;
  readonly catalog: Catalog;
  /**
   * Host retention: decided rules, declared purges and passes (scope 'retention'), the
   * per-customer clock, dispositions and holds (scope 'registry'), and the holds feed
   * (scope 'holds').
   */
  readonly retention: Retention;
  /** The host inventory resource (scope: 'inventory', reads also 'retention' / 'check'). */
  readonly inventory: Inventory;
  /** The break-glass operator lever (degrade gate 3). */
  readonly breakGlass: BreakGlass;
  /** The configured API base URL (client-side; the resolved endpoint in use). */
  readonly baseUrl: string;

  private readonly transport: Transport;
  private readonly degrade: DegradePolicy;

  constructor(options: AgreelyOptions) {
    if (!options.apiKey || options.apiKey.trim() === "") {
      throw new AgreelyConfigError("Agreely requires an apiKey.");
    }

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

    this.transport = new Transport({
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      timeoutMs,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.respectRetryAfter !== undefined
        ? { respectRetryAfter: options.respectRetryAfter }
        : {}),
    });

    // The shared upper bound for both break-glass ttl and maxOutageWindow.
    const maxDegradeWindowMs =
      options.maxDegradeWindow !== undefined
        ? parseDuration(options.maxDegradeWindow)
        : DEFAULT_MAX_DEGRADE_WINDOW_MS;

    this.breakGlass = new BreakGlass(options.onBreakGlass ?? (() => {}), maxDegradeWindowMs);
    // Construction validates the degrade config (fail-open without onDegrade throws,
    // an over-cap maxOutageWindow throws).
    this.degrade = new DegradePolicy(options.degradeOnOutage, this.breakGlass, maxDegradeWindowMs);

    this.consentRequests = new ConsentRequests(this.transport);
    this.consentDocuments = new ConsentDocuments(this.transport, timeoutMs);
    this.manualConsents = new ManualConsents(this.transport, timeoutMs);
    this.verbalConsents = new VerbalConsents(this.transport);
    this.withdrawals = new Withdrawals(this.transport);
    this.customers = new Customers(this.transport);
    this.relationships = new Relationships(this.transport);
    this.catalog = new Catalog(this.transport);
    this.retention = new Retention(this.transport, maxDegradeWindowMs);
    this.inventory = new Inventory(this.transport);
  }

  /**
   * Verify a consent receipt OFFLINE-FIRST (the headline). Reports exactly what is
   * PROVED vs merely trusted: a company-attested receipt is offline-sound; a citizen
   * receipt is honestly PARTIAL offline, because its company half signed the OFFER,
   * which the receipt omits for unlinkability. NO server endpoint re-checks that half;
   * it travels only in the separate verification bundle Agreely issues with the
   * receipt, which this verifier does not read. "Offline-first", not fully offline: the
   * signature/assertion checks need the signing key from the DID document (one HTTPS
   * resolution by default, or supply a local `resolver` for an air-gapped verify);
   * the IPFS disclosure copy and on-chain anchor are the opt-in extra calls. When a
   * DID cannot be resolved the check is "unavailable" (inconclusive), never "fail".
   * Static — no API key needed.
   *
   * SECURITY: when verifying UNTRUSTED receipts, inject your own `resolver` (or
   * supply DID documents locally) — the default did:web resolver fetches a host
   * taken from the receipt (HTTPS-only; it can never yield a false "verified").
   */
  static verifyReceipt(
    receipt: unknown,
    opts: VerifyReceiptOptions = {},
  ): Promise<ReceiptVerification> {
    return new ReceiptVerifier(opts).verify(receipt);
  }

  /**
   * Hash PDF bytes to the EXACT `evidence.pdfSha256` form the API expects:
   * "0x" + lowercase sha256 hex. Static; no network.
   */
  static hashPdf(bytes: Uint8Array): string {
    return "0x" + createHash("sha256").update(bytes).digest("hex");
  }

  /** Read a PDF from disk and hash it (Node) — see {@link Agreely.hashPdf}. */
  static async hashPdfFile(path: string): Promise<string> {
    return Agreely.hashPdf(await readFile(path));
  }

  /**
   * Identify the presented key against the server (GET /v1/whoami): the REAL,
   * server-verified scopes it carries, plus the tenant's name, regime and public
   * privacy page. Least-disclosure: no company id, no DID, no key metadata. Any
   * valid key reaches it.
   * A read; safe to auto-retry on a transient outage.
   *
   * As a liveness probe: call it about once a minute from ONE scheduler, not per
   * request (every call counts against the company's 120 a minute). On a 401 or a 402
   * purge whatever you cached from Agreely and fail closed. It never replaces a check:
   * never cache /v1/check, and never decide consent from a cached catalog.
   */
  identity(): Promise<Identity> {
    return this.transport.request<Identity>({
      method: "GET",
      path: "/v1/whoami",
      idempotentRetry: true,
    });
  }

  /**
   * The boolean-ergonomic consent gate. ALLOW is the only true. A 200 deny ->
   * false. On an outage, the fail-closed default returns false; the explicit,
   * scoped, audited exception (config + per-call opt, or break-glass) may
   * return true. NEVER throws on an outage — it resolves to a boolean.
   *
   * Send RAW category/purpose — the server normalizes. Labels may be French OR
   * English, with or without accents (case- and whitespace-insensitive); English
   * resolves only when the company disclosed an English label for that cell, and
   * an ambiguous/undeclared label fails closed.
   */
  async check(
    customerId: string,
    category: string,
    purpose: string,
    opts: CheckOptions = {},
  ): Promise<boolean> {
    try {
      const result = await this.resolve(customerId, category, purpose, opts);
      return result.decision === "allow";
    } catch (error) {
      // Fail-closed deny. An outage OR a lapsed company subscription (402) must
      // never resolve to an allow. checkDetailed() still THROWS the typed error
      // so a caller can surface "billing lapsed" distinctly.
      if (error instanceof AgreelyUnavailableError) return false;
      if (error instanceof AgreelyBillingInactiveError) return false;
      throw error; // auth / validation / rate-limit / not-found surface as errors
    }
  }

  /**
   * Batch consent check: evaluate many (customerRef, category, purpose) cells in
   * ONE round-trip instead of N calls to check(). Returns decisions ALIGNED to
   * the submitted items. Fail-closed: any tuple without an active record returns
   * deny/none. Sends category/purpose RAW (the server normalizes; the SDK never
   * does). On an outage throws AgreelyUnavailableError.
   *
   * CAP: at most {@link BATCH_CAP} (500) items per call. An over-cap list throws
   * AgreelyConfigError BEFORE any wire call, rather than spending a request on a 422
   * that decides nothing. Split into chunks of 500 and note that each chunk costs one
   * request against the 120/minute company allowance.
   */
  async checkBatch(items: BatchCheckItem[]): Promise<BatchDecision[]> {
    if (items.length === 0) return [];
    if (items.length > BATCH_CAP) {
      throw new AgreelyConfigError(
        `checkBatch: ${items.length} items exceeds the server cap of ${BATCH_CAP}. ` +
          `Split the batch into chunks of ${BATCH_CAP} or fewer.`,
      );
    }
    const result = await this.transport.request<{ decisions: BatchDecision[] }>({
      method: "POST",
      path: "/v1/check/batch",
      body: { items },
      idempotentRetry: true,
    });
    return result.decisions;
  }

  /**
   * Ergonomic cartesian-product batch check. Builds all (customerRef, field)
   * pairs, calls checkBatch once, and returns a lookup for `isAllowed` gates.
   * Sends category/purpose RAW. On an outage throws AgreelyUnavailableError.
   *
   * CAP: this builds refs x fields items, so it reaches the server's 500-item cap
   * FASTER than it looks: 100 rows x 6 fields is 600 items, over the cap. An over-cap
   * product throws AgreelyConfigError BEFORE any wire call, naming both multiplicands
   * so the fix is obvious (page the rows, or trim the field set).
   */
  async checkFields(
    customerRefs: string[],
    fields: Array<{ category: string; purpose: string }>,
  ): Promise<CheckFieldsResult> {
    const total = customerRefs.length * fields.length;
    if (total > BATCH_CAP) {
      const perCall = fields.length > 0 ? Math.floor(BATCH_CAP / fields.length) : BATCH_CAP;
      throw new AgreelyConfigError(
        `checkFields: ${customerRefs.length} customerRefs x ${fields.length} fields = ${total} cells, ` +
          `over the server cap of ${BATCH_CAP}. Page the customerRefs (at most ${perCall} per call with ` +
          `${fields.length} fields) or check fewer fields at a time.`,
      );
    }
    const items: BatchCheckItem[] = [];
    for (const customerRef of customerRefs) {
      for (const field of fields) {
        items.push({ customerRef, category: field.category, purpose: field.purpose });
      }
    }
    const decisions = await this.checkBatch(items);
    // Build an O(1) lookup map. Key: "customerRef\0category\0purpose" (raw strings).
    const map = new Map<string, boolean>();
    for (const d of decisions) {
      map.set(`${d.customerRef}\0${d.category}\0${d.purpose}`, d.decision === "allow");
    }
    return {
      decisions,
      isAllowed(customerRef: string, category: string, purpose: string): boolean {
        return map.get(`${customerRef}\0${category}\0${purpose}`) ?? false;
      },
    };
  }

  /**
   * The reasoned form: the full decision object. A 200 deny returns normally
   * (deny is not an error). On an outage it THROWS AgreelyUnavailableError when
   * the policy fails closed, or returns a degraded allow (degraded:true) when
   * the explicit exception applies.
   */
  checkDetailed(
    customerId: string,
    category: string,
    purpose: string,
    opts: CheckOptions = {},
  ): Promise<CheckResult> {
    return this.resolve(customerId, category, purpose, opts);
  }

  /**
   * Shared resolution. Sends category/purpose RAW (the server normalizes — the
   * SDK never does). On a 200, returns the server decision and clears any outage
   * window. On an outage, applies the degrade policy: a degraded allow returns a
   * synthesized allow result; a fail-closed outcome rethrows the outage error.
   */
  private async resolve(
    customerId: string,
    category: string,
    purpose: string,
    opts: CheckOptions,
  ): Promise<CheckResult> {
    try {
      const result = await this.transport.request<CheckResult>({
        method: "POST",
        path: "/v1/check",
        body: { customerId, category, purpose },
        idempotentRetry: true, // the check is a pure read; safe to retry
      });
      this.degrade.markSuccess();
      return result;
    } catch (error) {
      if (!(error instanceof AgreelyUnavailableError)) throw error;
      // Per-call explicit fail-closed shortcut.
      if (opts.onOutage === "deny") throw error;

      const decision = this.degrade.evaluate({ customerId, category, purpose, opts, error });
      if (!decision.allow) throw error; // fail closed -> surface the outage

      return {
        decision: "allow",
        status: "active",
        checkedAt: new Date().toISOString(),
        degraded: true,
        ...(decision.mode !== undefined ? { mode: decision.mode } : {}),
      };
    }
  }
}
