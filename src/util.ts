import { AgreelyConfigError } from "./errors.js";

/**
 * Parse a short duration string ("30s", "5m", "1h", "500ms") to milliseconds.
 * Used for maxOutageWindow and break-glass ttl. Throws AgreelyConfigError on a
 * malformed value so misconfig surfaces early, not mid-outage.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)$/.exec(input.trim());
  if (!match) {
    throw new AgreelyConfigError(
      `Invalid duration "${input}". Use forms like "500ms", "30s", "5m", "1h".`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2];
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return value * scale;
}

/**
 * A LOCAL policy key for degrade allow-list / break-glass scope matching ONLY.
 *
 * IMPORTANT: this is NOT the server's CatalogEntry::normalizeKey and is NEVER
 * applied to the category/purpose SENT to the server (those go raw — the hard
 * rule). This only decides whether a category the integrator pre-declared in
 * config matches the category at a call site, so "Browsing/usage" and
 * " browsing/usage " gate the same way. A purely local, transparent comparison.
 */
export function localPolicyKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Default upper bound for an open degrade window — both a break-glass `ttl` and
 * a `degradeOnOutage.maxOutageWindow`. 24h. An accountability product must not
 * let an operator open an effectively-unbounded fail-open window ("9999h"); the
 * cap is overridable per-client via the `maxDegradeWindow` option.
 */
export const DEFAULT_MAX_DEGRADE_WINDOW_MS = 24 * 3_600_000;

/** Render a millisecond count back to a compact duration string for messages. */
function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * Parse a duration AND enforce an upper bound. Throws AgreelyConfigError when the
 * value exceeds `maxMs`. An unbounded degrade / break-glass window is itself a
 * compliance risk, so the SDK refuses it at construction / engage time rather
 * than mid-outage. `label` names the offending field for the message.
 */
export function parseDurationCapped(input: string, maxMs: number, label: string): number {
  const ms = parseDuration(input);
  if (ms > maxMs) {
    throw new AgreelyConfigError(
      `${label} "${input}" exceeds the maximum allowed window (${formatDuration(maxMs)}). ` +
        `Lower it, or raise the cap via the client \`maxDegradeWindow\` option.`,
    );
  }
  return ms;
}

/** Sleep for ms (used for jittered retry backoff). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A small jittered backoff for retry attempt N (1-based). Full jitter over a
 * tiny base so two retries stay well within an ~800ms budget.
 */
export function jitterBackoff(attempt: number): number {
  const base = 25 * attempt;
  return Math.floor(Math.random() * base);
}
