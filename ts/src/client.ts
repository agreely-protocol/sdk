import { BreakGlass } from "./breakGlass.js";
import { DegradePolicy } from "./degrade.js";
import { AgreelyConfigError, AgreelyUnavailableError } from "./errors.js";
import { Catalog } from "./resources/catalog.js";
import { ConsentRequests } from "./resources/consentRequests.js";
import { Transport } from "./transport.js";
import type { AgreelyOptions, CheckOptions, CheckResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.agreely.org";
const DEFAULT_TIMEOUT_MS = 800;

/**
 * The Agreely client: a thin, near-stateless gate over the /v1 API. It holds an
 * api key, a base URL, a fetch client, a timeout, and the degrade policy — NO
 * database, NO ref tables, and NO allow-cache (caching an allow while a revoke
 * lands mid-window is a stale-allow correctness failure, spec §16). Every
 * check() is a fresh authoritative call.
 */
export class Agreely {
  readonly consentRequests: ConsentRequests;
  readonly catalog: Catalog;
  /** The break-glass operator lever (degrade gate 3). */
  readonly breakGlass: BreakGlass;

  private readonly transport: Transport;
  private readonly degrade: DegradePolicy;

  constructor(options: AgreelyOptions) {
    if (!options.apiKey || options.apiKey.trim() === "") {
      throw new AgreelyConfigError("Agreely requires an apiKey.");
    }

    this.transport = new Transport({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });

    this.breakGlass = new BreakGlass(options.onBreakGlass ?? (() => {}));
    // Construction validates the degrade config (fail-open without onDegrade throws).
    this.degrade = new DegradePolicy(options.degradeOnOutage, this.breakGlass);

    this.consentRequests = new ConsentRequests(this.transport);
    this.catalog = new Catalog(this.transport);
  }

  /**
   * The boolean-ergonomic consent gate. ALLOW is the only true. A 200 deny ->
   * false. On an outage, the fail-closed default returns false; the explicit,
   * scoped, audited exception (config + per-call opt, or break-glass) may
   * return true. NEVER throws on an outage — it resolves to a boolean.
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
      if (error instanceof AgreelyUnavailableError) return false; // fail-closed deny
      throw error; // auth / validation / rate-limit / not-found surface as errors
    }
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
