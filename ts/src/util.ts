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
