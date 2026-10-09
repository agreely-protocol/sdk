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
 * applied to the category/purpose SENT to the server (those go raw, the hard
 * rule). This only decides whether a category the integrator pre-declared in
 * config matches the category at a call site, so "Browsing/usage" and
 * " browsing/usage " gate the same way. A purely local, transparent comparison.
 */
export function localPolicyKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Default upper bound for an open degrade window, both a break-glass `ttl` and
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

/**
 * The host-token shape the server enforces, mirrored so a bad value fails before
 * the wire call: a slug, no run of 5 digits, no run of 8+ hexadecimal characters
 * containing a digit (a uuid, a hash, a pod suffix). The server stays the
 * authority; this only saves a round trip, and it cannot catch a well-formed value
 * that still changes per deploy (see HostToken in types.ts).
 */
export function assertHostToken(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ||
    /\d{5}/.test(value) ||
    /(?=[0-9a-f]*\d)[0-9a-f]{8,}/.test(value)
  ) {
    throw new AgreelyConfigError(
      `${label} must name a system or a kind of records as a stable slug (lowercase letters, digits, . _ -; ` +
        `at most 64 characters; no run of 5 digits; no hexadecimal identifier). A pod name, a container id or ` +
        `a record id is refused, and a value that changes per deploy burns one of the 10 host systems allowed ` +
        `per 30 days.`,
    );
  }
  return value;
}

/** RFC 3339 with an EXPLICIT offset, as the server requires. */
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An instant for the wire: a Date is sent in UTC; a string must already carry an
 * explicit offset (a naive timestamp would be read in the server's zone and
 * silently re-date the evidence, so it is refused rather than guessed). Returns
 * the wire string and its epoch milliseconds.
 */
export function toWireInstant(value: unknown, label: string): { wire: string; ms: number } {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new AgreelyConfigError(`${label} is an invalid Date.`);
    return { wire: value.toISOString(), ms };
  }
  if (typeof value === "string" && RFC3339_WITH_OFFSET.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return { wire: value, ms };
  }
  throw new AgreelyConfigError(
    `${label} must be a Date or an RFC 3339 date and time with an explicit offset, e.g. 2026-09-25T03:00:00-04:00.`,
  );
}

/**
 * The Idempotency-Key the declaration endpoints require: 1 to 255 printable ASCII
 * characters. Refused client-side rather than truncated or sent to a sure 422.
 */
export function assertIdempotencyKey(options: unknown, label: string): string {
  const key = (options as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  if (typeof key !== "string" || !/^[\x21-\x7E]{1,255}$/.test(key)) {
    throw new AgreelyConfigError(
      `${label} requires an idempotencyKey option (the Idempotency-Key header): 1 to 255 printable ASCII ` +
        `characters, derived from something durable such as your job-run id and the rule key.`,
    );
  }
  return key;
}

/**
 * The Idempotency-Key of a consent-recording call (manual, verbal, paper): the
 * caller's override when given, else a fresh one. The server binds the key to the
 * endpoint and to the request body, and refuses anything but 1 to 255 printable
 * ASCII characters with a 422, so a bad override is refused here, before the call.
 */
export function recordIdempotencyKey(override: unknown, label: string): string {
  if (override === undefined) return `idem_${globalThis.crypto.randomUUID()}`;
  if (typeof override !== "string" || !/^[\x21-\x7E]{1,255}$/.test(override)) {
    throw new AgreelyConfigError(
      `${label}: idempotencyKey must be 1 to 255 printable ASCII characters (no spaces).`,
    );
  }
  return override;
}

/** The longest customerRef the server accepts (characters). */
export const CUSTOMER_REF_MAX = 200;

/**
 * The server's own trim (PHP's: space, tab, newline, carriage return, NUL, vertical tab).
 * JavaScript's `trim()` also strips Unicode spaces the server keeps, which would address
 * a different customer than the one the caller named.
 */
const SERVER_TRIM = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g;

/**
 * A customerRef for a /v1/customers/{customerRef} path: 1 to 200 characters once
 * trimmed exactly as the server trims it, and never "." or "..", which the URL parser
 * would resolve as a path step (`placeHold("..")` would post to /v1/retention/holds).
 * A "/" or a "%" is fine: the path segment is percent-encoded. Refused client-side
 * otherwise (the server would answer a 404 or a 422 the caller cannot fix by retrying).
 */
export function requireCustomerRef(value: unknown, label: string): string {
  const ref = typeof value === "string" ? value.replace(SERVER_TRIM, "") : "";
  if (ref === "" || [...ref].length > CUSTOMER_REF_MAX) {
    throw new AgreelyConfigError(`${label} requires a customerRef of 1 to ${CUSTOMER_REF_MAX} characters.`);
  }
  if (ref === "." || ref === "..") {
    throw new AgreelyConfigError(`${label}: "${ref}" cannot be a customerRef in a URL path.`);
  }
  return ref;
}

/**
 * Refuse an options object carrying anything but the named members. A misspelt
 * `idempotencykey` would otherwise be ignored and replaced by a random key, so a retry
 * the caller believed safe would record twice.
 */
export function assertOptions(options: unknown, allowed: readonly string[], label: string): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new AgreelyConfigError(`${label}: options must be an object.`);
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new AgreelyConfigError(`${label}: unknown option "${key}" (accepted: ${allowed.join(", ")}).`);
    }
  }
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A uuid path segment, lowercased. Anything else is a 404 server-side, so it is refused here. */
export function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    throw new AgreelyConfigError(`${label} must be a uuid.`);
  }
  return value.trim().toLowerCase();
}

/**
 * The time budget of a call that makes the server render a PDF: the per-call override
 * when given (a positive number of ms), else the larger of the client's budget and
 * `floorMs`. The client default (800 ms) is sized for the consent check, and a cut-off
 * render on a minting route loses an answer the server returns only once.
 */
export function renderBudget(override: unknown, clientTimeoutMs: number, floorMs: number, label: string): number {
  if (override === undefined) return Math.max(clientTimeoutMs, floorMs);
  if (typeof override !== "number" || !Number.isFinite(override) || override <= 0) {
    throw new AgreelyConfigError(`${label}: timeout must be a positive number of milliseconds.`);
  }
  return override;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date, YYYY-MM-DD, refused client-side otherwise. */
export function requireDay(value: unknown, label: string): string {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) {
    throw new AgreelyConfigError(`${label} must be a calendar date, YYYY-MM-DD.`);
  }
  return value;
}
