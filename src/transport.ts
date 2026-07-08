import {
  AgreelyAuthError,
  AgreelyError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelyUnavailableError,
  AgreelyValidationError,
  type AgreelyErrorCode,
} from "./errors.js";
import { jitterBackoff, sleep } from "./util.js";

export interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Whether this call may be retried on a transient outage (network / 503).
   * TRUE only for idempotent reads and the check (a pure read). NEVER for
   * consentRequests.create — it emails; a retry there must replay via the
   * Idempotency-Key, not re-issue.
   */
  idempotentRetry?: boolean;
}

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
    const rateRetries = spec.idempotentRetry ? this.maxRetries : 0;
    let rateAttempt = 0;
    for (;;) {
      try {
        return await this.attempt<T>(spec);
      } catch (error) {
        if (error instanceof AgreelyRateLimitError && rateAttempt < rateRetries) {
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
  private async attempt<T>(spec: RequestSpec): Promise<T> {
    const fetchImpl = await this.resolveFetch();
    const url = this.buildUrl(spec.path, spec.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...spec.headers,
    };
    let bodyText: string | undefined;
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(spec.body);
    }

    const deadline = Date.now() + this.timeoutMs;
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
        clearTimeout(timer);
        return await this.handle<T>(res);
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

  /** Map a fetch Response to parsed JSON, or throw the typed error for its status. */
  private async handle<T>(res: Response): Promise<T> {
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    const payload = await this.safeJson(res);
    const wire = (payload as { error?: { code?: string; message?: string; field?: string } })
      ?.error;
    const message = wire?.message ?? `Agreely request failed (HTTP ${res.status}).`;
    const code = (wire?.code as AgreelyErrorCode | undefined) ?? undefined;
    const field = wire?.field;

    switch (res.status) {
      case 401:
      case 403:
        throw new AgreelyAuthError(message, { code: code ?? "unauthorized", status: res.status });
      case 400:
      case 422:
        throw new AgreelyValidationError(message, {
          code: code ?? "invalid_request",
          status: res.status,
          ...(field !== undefined ? { field } : {}),
        });
      case 404:
        throw new AgreelyNotFoundError(message, { code: code ?? "not_found", status: res.status });
      case 429: {
        const header = res.headers.get("Retry-After");
        const retryAfter = header !== null ? Number(header) : undefined;
        throw new AgreelyRateLimitError(message, {
          code: "rate_limited",
          status: res.status,
          ...(retryAfter !== undefined && !Number.isNaN(retryAfter) ? { retryAfter } : {}),
        });
      }
      default:
        // 503 and any other 5xx: unreachable. 503 is retryable for idempotent calls.
        throw new AgreelyUnavailableError(message, {
          status: res.status,
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
