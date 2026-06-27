import { AgreelyConfigError } from "./errors.js";
import type { BreakGlassEngageInput, BreakGlassEvent } from "./types.js";
import { localPolicyKey, parseDuration } from "./util.js";

interface EngagedState {
  reason: string;
  scope: string[] | undefined;
  expiresAt: number;
}

/**
 * The break-glass lever (degrade gate 3): an explicit, auto-expiring operator
 * override for an active outage. Independent of the config allow-list — it is
 * the runtime emergency switch when the outage policy wasn't pre-armed. Every
 * engage / disengage / expiry is audited via the onBreakGlass sink.
 */
export class BreakGlass {
  private state: EngagedState | null = null;

  constructor(private readonly audit: (event: BreakGlassEvent) => void) {}

  /** Engage break-glass. Reason is mandatory; without it this throws. */
  engage(input: BreakGlassEngageInput): void {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new AgreelyConfigError("breakGlass.engage requires a non-empty reason.");
    }
    const ttlMs = parseDuration(input.ttl);
    const expiresAt = Date.now() + ttlMs;
    this.state = {
      reason,
      scope: input.scope ? [...input.scope] : undefined,
      expiresAt,
    };
    this.audit({
      action: "engage",
      reason,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ttl: input.ttl,
      at: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /** Manually stand down before ttl. Audited. No-op when not engaged. */
  disengage(): void {
    if (!this.state) return;
    const reason = this.state.reason;
    this.state = null;
    this.audit({ action: "disengage", reason, at: new Date().toISOString() });
  }

  /** Whether break-glass is currently engaged (and not expired). */
  isEngaged(): boolean {
    return this.current() !== null;
  }

  /**
   * The active reason for a category, or null if break-glass does not cover it
   * (not engaged, expired, or category outside the engaged scope).
   */
  reasonFor(category: string): string | null {
    const state = this.current();
    if (!state) return null;
    if (state.scope === undefined) return state.reason; // no scope = all categories
    const key = localPolicyKey(category);
    return state.scope.some((c) => localPolicyKey(c) === key) ? state.reason : null;
  }

  /** Resolve the live state, expiring (and auditing the expiry) if ttl passed. */
  private current(): EngagedState | null {
    if (!this.state) return null;
    if (Date.now() >= this.state.expiresAt) {
      const reason = this.state.reason;
      this.state = null;
      this.audit({ action: "expire", reason, at: new Date().toISOString() });
      return null;
    }
    return this.state;
  }
}
