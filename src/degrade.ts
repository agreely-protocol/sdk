import type { BreakGlass } from "./breakGlass.js";
import { AgreelyConfigError } from "./errors.js";
import type {
  CheckOptions,
  DegradeContext,
  DegradeMode,
  DegradeOnOutageConfig,
} from "./types.js";
import {
  DEFAULT_MAX_DEGRADE_WINDOW_MS,
  localPolicyKey,
  parseDurationCapped,
} from "./util.js";

export interface OutageInput {
  customerId: string;
  category: string;
  purpose: string;
  opts: CheckOptions;
  error: Error;
}

export interface DegradeDecision {
  allow: boolean;
  mode?: DegradeMode;
}

/**
 * The fail-closed default + the three-gate exception (David's decision).
 *
 * Default: on a 503 / timeout / network error, DENY. The exception is explicit,
 * scoped, and audited — never a silent global allow:
 *
 *   Gate 3 (break-glass): an engaged operator override allows a degraded check
 *     within its scope+ttl, tagged breakGlass:true. Independent of config.
 *   Gates 1+2 (config + per-call): a category fails open ONLY when it is in the
 *     config allow-list (gate 1) AND the call passes opts.onOutage:"allow"
 *     (gate 2) — two independent gates — and the outage is still within
 *     maxOutageWindow.
 *
 * A 200 deny never reaches here (it is not an outage). Every degraded ALLOW
 * emits a DegradeContext via onDegrade; the fail-closed path emits nothing.
 */
export class DegradePolicy {
  private readonly config: DegradeOnOutageConfig | undefined;
  private readonly allowList: Set<string>;
  private readonly maxOutageWindowMs: number | undefined;
  private outageStartedAt: number | null = null;
  /** One-time guard so an ineffective-opt-in warning doesn't spam the logs. */
  private warnedIneffectiveOptIn = false;

  constructor(
    config: DegradeOnOutageConfig | undefined,
    private readonly breakGlass: BreakGlass,
    private readonly maxWindowMs: number = DEFAULT_MAX_DEGRADE_WINDOW_MS,
  ) {
    if (config) {
      if (config.mode !== "fail-open") {
        throw new AgreelyConfigError(
          `degradeOnOutage.mode must be "fail-open"; got "${String(config.mode)}".`,
        );
      }
      if (typeof config.onDegrade !== "function") {
        throw new AgreelyConfigError(
          "degradeOnOutage.onDegrade is mandatory when mode is \"fail-open\".",
        );
      }
      // Cap the window (refuse an unbounded "9999h" fail-open window).
      this.maxOutageWindowMs = parseDurationCapped(
        config.maxOutageWindow,
        this.maxWindowMs,
        "degradeOnOutage.maxOutageWindow",
      );
      this.allowList = new Set((config.categories ?? []).map(localPolicyKey));
    } else {
      this.allowList = new Set();
      this.maxOutageWindowMs = undefined;
    }
    this.config = config;
  }

  /** A successful (200) check ends any tracked outage window. */
  markSuccess(): void {
    this.outageStartedAt = null;
  }

  /**
   * Decide an outage. Returns { allow } and, for an allow, emits the audit
   * record. Denies (fail-closed) are silent.
   */
  evaluate(input: OutageInput): DegradeDecision {
    const now = Date.now();
    if (this.outageStartedAt === null) this.outageStartedAt = now;

    // Gate 3: break-glass (independent operator override, own scope + ttl).
    const bgReason = this.breakGlass.reasonFor(input.category);
    if (bgReason !== null) {
      // ALWAYS record a per-decision audit for a break-glass allow — even with no
      // degradeOnOutage config there must be an evidence trail of every access
      // allowed inside the break-glass window (compliance invariant).
      this.breakGlass.recordAuthorized({
        customerId: input.customerId,
        category: input.category,
        purpose: input.purpose,
        reason: bgReason,
        error: input.error,
        at: new Date().toISOString(),
      });
      // Also surface through onDegrade when a config sink is present.
      this.emit(input, "break-glass", true, bgReason);
      return { allow: true, mode: "break-glass" };
    }

    // Gates 1 + 2: config allow-list AND per-call opt-in.
    const inAllowList =
      this.config !== undefined && this.allowList.has(localPolicyKey(input.category));
    const optedIn = input.opts.onOutage === "allow";
    if (inAllowList && optedIn) {
      // maxOutageWindow: refuse to keep degrading past the window (fail closed).
      if (
        this.maxOutageWindowMs !== undefined &&
        now - this.outageStartedAt > this.maxOutageWindowMs
      ) {
        return { allow: false };
      }
      this.emit(input, "fail-open", false);
      return { allow: true, mode: "fail-open" };
    }

    // A per-call opt-in that reached here had NO effect (the category is not in
    // the config allow-list, or no degradeOnOutage config exists). It STILL
    // denies (safety unchanged), but the silent no-op is a footgun — warn once.
    if (optedIn) this.warnIneffectiveOptIn(input.category);

    // Default: fail closed.
    return { allow: false };
  }

  /**
   * Dev-mode, fire-once warning that a per-call `onOutage:"allow"` was ignored
   * and the check was denied. Gated to one emission per policy instance and
   * silenceable via the `AGREELY_SILENCE_WARNINGS` env var. Never weakens safety.
   */
  private warnIneffectiveOptIn(category: string): void {
    if (this.warnedIneffectiveOptIn) return;
    const env = typeof process !== "undefined" ? process.env : undefined;
    if (env?.AGREELY_SILENCE_WARNINGS) return;
    this.warnedIneffectiveOptIn = true;
    console.warn(
      `[agreely] onOutage:"allow" had no effect for category "${category}" — the check was DENIED. ` +
        `A per-call fail-open is effective ONLY when the category is also listed in ` +
        `degradeOnOutage.categories (and degradeOnOutage is configured). Add the category to ` +
        `the allow-list, or engage break-glass for an ad-hoc override. ` +
        `(Warns once per client; set AGREELY_SILENCE_WARNINGS to silence.)`,
    );
  }

  private emit(input: OutageInput, mode: DegradeMode, breakGlass: boolean, reason?: string): void {
    if (!this.config) {
      // No onDegrade sink. A break-glass allow's per-decision evidence is already
      // recorded via breakGlass.recordAuthorized (onBreakGlass), so the audit
      // trail is complete even without a degradeOnOutage config.
      return;
    }
    const ctx: DegradeContext = {
      customerId: input.customerId,
      category: input.category,
      purpose: input.purpose,
      mode,
      breakGlass,
      error: input.error,
      at: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.config.onDegrade(ctx);
  }
}
