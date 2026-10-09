import {
  AgreelyAuthError,
  AgreelyBillingInactiveError,
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelySweepTooFrequentError,
  AgreelyUnavailableError,
  AgreelyVerbalDailyCapError,
  AgreelyValidationError,
  type AgreelyErrorCode,
  type AgreelyErrorReason,
} from "./errors.js";
import { jitterBackoff, sleep } from "./util.js";

export interface RequestSpec {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Whether this call may be retried on a transient outage (network / 503).
   * TRUE only for idempotent reads and the check (a pure read). NEVER for
   * consentRequests.create, it emails; a retry there must replay via the
   * Idempotency-Key, not re-issue.
   */
  idempotentRetry?: boolean;
  /**
   * This call's total time budget in ms, overriding the client's `timeout`. Used by the
   * routes that render a PDF, which a budget sized for the consent check would cut off.
   */
  timeoutMs?: number;
}

/** A JSON response with its HTTP status, for the routes whose status carries meaning (201 vs 200). */
export interface JsonExchange<T> {
  status: number;
  body: T;
}

/** A binary response (a PDF), with the headers that describe it. */
export interface BytesExchange {
  bytes: Uint8Array;
  contentType: string | null;
  contentDisposition: string | null;
}

/** The 429 codes that are a per-company DAILY cap (besides `verbal_daily_cap`), never the per-minute window. */
const DAILY_CAP_CODES: ReadonlySet<string> = new Set([
  "withdrawal_daily_cap",
  "hold_budget_exhausted",
  "hold_release_cap_reached",
]);

type FetchLike = typeof fetch;

/**
 * The thin HTTP layer: build the request, enforce a single total time budget
 * across attempts, map every response/failure to a typed error, and retry ONLY
 * idempotent calls on a transient outage (network error or 503), capped at two
 * attempts with jittered backoff, all inside the budget.
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly respectRetryAfter: boolean;
  private fetchImpl: FetchLike | undefined;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    fetch?: FetchLike;
    maxRetries?: number;
    respectRetryAfter?: boolean;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries ?? 0;
    this.respectRetryAfter = opts.respectRetryAfter ?? true;
    this.fetchImpl = opts.fetch;
  }

  /**
   * Send a request. On a 429 for an IDEMPOTENT call, opt-in retry up to
   * `maxRetries` times, honoring Retry-After (outside the per-attempt time
   * budget). A mutating call never auto-retries a 429.
   */
  async request<T>(spec: RequestSpec): Promise<T> {
    return (await this.send(spec, (res) => this.parseJson<T>(res))).body;
  }

  /** As {@link request}, keeping the HTTP status (a PUT that answers 201 created or 200 merged). */
  requestWithStatus<T>(spec: RequestSpec): Promise<JsonExchange<T>> {
    return this.send(spec, (res) => this.parseJson<T>(res));
  }

  /**
   * A binary response (a PDF). The bytes are returned as received; an error still
   * arrives as the JSON envelope and maps to the same typed errors as every call.
   */
  requestBytes(spec: RequestSpec): Promise<BytesExchange> {
    return this.send({ ...spec, accept: "application/pdf, application/json" }, async (res) => ({
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("Content-Type"),
      contentDisposition: res.headers.get("Content-Disposition"),
    }));
  }

  /** The 429 retry loop around one budgeted send, shared by every response kind. */
  private async send<R>(
    spec: RequestSpec & { accept?: string },
    parse: (res: Response) => Promise<R>,
  ): Promise<R> {
    const rateRetries = spec.idempotentRetry ? this.maxRetries : 0;
    let rateAttempt = 0;
    for (;;) {
      try {
        return await this.attempt(spec, parse);
      } catch (error) {
        // ONLY the per-minute window (`rate_limited`) is ever auto-retried. A per-rule
        // floor, a daily cap or a 429 code this SDK does not know is not that window:
        // waiting it out and re-sending cannot be assumed to help.
        const windowed =
          error instanceof AgreelyRateLimitError &&
          error.code === "rate_limited" &&
          !(error instanceof AgreelySweepTooFrequentError) &&
          !(error instanceof AgreelyDailyCapError);
        if (windowed && rateAttempt < rateRetries) {
          rateAttempt++;
          const waitMs =
            this.respectRetryAfter && error.retryAfterSeconds !== undefined
              ? error.retryAfterSeconds * 1000
              : jitterBackoff(rateAttempt);
          await sleep(waitMs);
          continue;
        }
        throw error;
      }
    }
  }

  /** One budgeted send with transient-outage retries inside a single time budget. */
  private async attempt<R>(
    spec: RequestSpec & { accept?: string },
    parse: (res: Response) => Promise<R>,
  ): Promise<R> {
    const fetchImpl = await this.resolveFetch();
    const url = this.buildUrl(spec.path, spec.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: spec.accept ?? "application/json",
      ...spec.headers,
    };
    let bodyText: string | undefined;
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(spec.body);
    }

    const deadline = Date.now() + (spec.timeoutMs ?? this.timeoutMs);
    const maxAttempts = spec.idempotentRetry ? 2 : 1;
    let lastError: AgreelyError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      const init: RequestInit = {
        method: spec.method,
        headers,
        signal: controller.signal,
      };
      if (bodyText !== undefined) init.body = bodyText;
      try {
        const res = await fetchImpl(url, init);
        // The timer stays armed while the body is read: a body that stalls is the same
        // outage as a response that never came.
        const result = res.ok ? await parse(res) : await this.fail(res);
        clearTimeout(timer);
        return result;
      } catch (raw) {
        clearTimeout(timer);
        lastError = this.normalize(raw);
        const transient =
          lastError instanceof AgreelyUnavailableError && lastError.retryable;
        const canRetry = Boolean(spec.idempotentRetry) && transient && attempt < maxAttempts;
        if (!canRetry) throw lastError;

        const backoff = jitterBackoff(attempt);
        if (Date.now() + backoff >= deadline) throw lastError;
        await sleep(backoff);
      }
    }

    throw (
      lastError ??
      new AgreelyUnavailableError("Agreely was unreachable within the time budget.", {
        retryable: true,
      })
    );
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /** Parse a successful JSON response (an empty body reads as an empty object). */
  private async parseJson<T>(res: Response): Promise<JsonExchange<T>> {
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  /**
   * Throw the typed error for a failed response. `field` and `reason` travel on every
   * status when the envelope carries them: a client compares `reason`, never `message`.
   */
  private async fail(res: Response): Promise<never> {
    const payload = await this.safeJson(res);
    const wire = (payload as { error?: { code?: unknown; message?: unknown; field?: unknown; reason?: unknown } })
      ?.error;
    const message =
      typeof wire?.message === "string" ? wire.message : `Agreely request failed (HTTP ${res.status}).`;
    const code = typeof wire?.code === "string" ? (wire.code as AgreelyErrorCode) : undefined;
    const detail = {
      status: res.status,
      ...(typeof wire?.field === "string" ? { field: wire.field } : {}),
      ...(typeof wire?.reason === "string" ? { reason: wire.reason as AgreelyErrorReason } : {}),
    };

    switch (res.status) {
      case 401:
      case 403:
        throw new AgreelyAuthError(message, { ...detail, code: code ?? "unauthorized" });
      case 400:
      case 413:
      case 422:
        throw new AgreelyValidationError(message, { ...detail, code: code ?? "invalid_request" });
      case 404:
        throw new AgreelyNotFoundError(message, { ...detail, code: code ?? "not_found" });
      case 402:
        // The company's Agreely subscription is inactive/lapsed. Fail-closed for
        // gating, but distinct from an outage: not transient, not retryable.
        throw new AgreelyBillingInactiveError(message, { ...detail, code: code ?? "billing_inactive" });
      case 409:
        // `retry`: a concurrent retry could not be settled (retry with the same key).
        // `conflict`: the request contradicts the record's state (do not retry as is).
        throw new AgreelyConflictError(message, { ...detail, code: code ?? "retry" });
      case 429: {
        const header = res.headers.get("Retry-After");
        const retryAfter = header !== null ? Number(header) : undefined;
        const init = {
          ...detail,
          ...(retryAfter !== undefined && !Number.isNaN(retryAfter) ? { retryAfter } : {}),
        };
        // The sweep floor is its own condition, not the company rate window.
        if (code === "sweep_too_frequent") {
          throw new AgreelySweepTooFrequentError(message, { ...init, code: "sweep_too_frequent" });
        }
        if (code === "verbal_daily_cap") {
          throw new AgreelyVerbalDailyCapError(message, { ...init, code: "verbal_daily_cap" });
        }
        // A known daily-cap code, or any 429 whose reason is `daily_cap`: a cap, keeping its code.
        if ((code !== undefined && DAILY_CAP_CODES.has(code)) || detail.reason === "daily_cap") {
          throw new AgreelyDailyCapError(message, { ...init, code: code ?? "rate_limited" });
        }
        // The per-minute window (`rate_limited`, or a 429 with no code at all, from a proxy)
        // is the only one the transport retries. Any other code keeps its own, never rewritten
        // to `rate_limited`, so it is never retried as if it were the window.
        throw new AgreelyRateLimitError(message, { ...init, code: code ?? "rate_limited" });
      }
      default:
        // 503 and any other 5xx (and an unmapped status such as 405 or 410): unreachable.
        // 503 is retryable for idempotent calls. `field` and `reason` travel here too.
        throw new AgreelyUnavailableError(message, {
          ...detail,
          retryable: res.status === 503,
        });
    }
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Turn a thrown value into a typed error. Aborts/network failures become unavailable. */
  private normalize(raw: unknown): AgreelyError {
    if (raw instanceof AgreelyError) return raw;
    if (raw instanceof Error && raw.name === "AbortError") {
      return new AgreelyUnavailableError("Agreely request timed out.", {
        retryable: true,
        cause: raw,
      });
    }
    return new AgreelyUnavailableError("Agreely could not be reached (network error).", {
      retryable: true,
      cause: raw,
    });
  }

  /** Global fetch (Node 18+), falling back to a lazily-imported undici. */
  private async resolveFetch(): Promise<FetchLike> {
    if (this.fetchImpl) return this.fetchImpl;
    if (typeof globalThis.fetch === "function") {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
      return this.fetchImpl;
    }
    try {
      const undici = (await import("undici")) as { fetch: FetchLike };
      this.fetchImpl = undici.fetch;
      return this.fetchImpl;
    } catch (cause) {
      throw new AgreelyUnavailableError(
        "No fetch implementation available. Use Node 18+ or install `undici`.",
        { cause },
      );
    }
  }
}
