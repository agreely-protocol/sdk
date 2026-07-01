import { AgreelyAbortError, AgreelyRateLimitError, AgreelyTimeoutError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  ConsentRequestPage,
  ConsentRequestRecord,
  ConsentRequestStatus,
  CreateConsentRequestInput,
  IssuedRequest,
  ListAllConsentRequestsInput,
  ListConsentRequestsInput,
  WaitForSettlementOptions,
} from "../types.js";
import { sleep } from "../util.js";

/** The terminal (settled) consent-request statuses. */
const TERMINAL_STATUSES: ReadonlySet<ConsentRequestStatus> = new Set([
  "approved",
  "refused",
  "expired",
  "revoked_before_action",
]);

/** Default guard so an unbounded list can never spin forever. */
const DEFAULT_MAX_PAGES = 1000;

interface CreateOptions {
  /**
   * Override the auto-generated Idempotency-Key. Reuse the SAME key across a
   * retry to replay the original 201 byte-for-byte (no double-issue, no
   * double-email).
   */
  idempotencyKey?: string;
}

/** The wire shape of GET /v1/consent-requests (note: `requests`, not `items`). */
interface ListWire {
  requests: ConsentRequestRecord[];
  nextCursor: string | null;
}

/**
 * The consent-request resource (scope: 'issue'). Keyed throughout on the
 * PROTOCOL requestId (0x + 64hex), never the internal uuid.
 */
export class ConsentRequests {
  constructor(private readonly transport: Transport) {}

  /**
   * Issue a consent request. Items are catalog ids and/or raw {category,
   * purpose} pairs — sent RAW, resolved server-side. NEVER auto-retried (it
   * emails): an Idempotency-Key is auto-generated per call (overridable) so a
   * caller-driven retry replays rather than double-issues.
   */
  create(input: CreateConsentRequestInput, options: CreateOptions = {}): Promise<IssuedRequest> {
    const idempotencyKey = options.idempotencyKey ?? generateIdempotencyKey();
    return this.transport.request<IssuedRequest>({
      method: "POST",
      path: "/v1/consent-requests",
      body: {
        customerId: input.customerId,
        recipientEmail: input.recipientEmail,
        validUntil: input.validUntil,
        items: input.items,
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /** List the company's requests, newest first, with optional status filter + cursor. */
  async list(input: ListConsentRequestsInput = {}): Promise<ConsentRequestPage> {
    const wire = await this.transport.request<ListWire>({
      method: "GET",
      path: "/v1/consent-requests",
      query: { status: input.status, cursor: input.cursor },
      idempotentRetry: true,
    });
    // Coerce an absent nextCursor to null so listAll stops exactly like PHP's
    // fromWire does (the API always emits it; this keeps strict TS<->PHP parity).
    return { items: wire.requests, nextCursor: wire.nextCursor ?? null };
  }

  /** Fetch one request by its protocol requestId (0x + 64hex). */
  get(requestId: string): Promise<ConsentRequestRecord> {
    return this.transport.request<ConsentRequestRecord>({
      method: "GET",
      path: `/v1/consent-requests/${encodeURIComponent(requestId)}`,
      idempotentRetry: true,
    });
  }

  /**
   * Auto-paginate over ALL requests as an async iterable, looping `nextCursor`
   * for you. Bounded by `maxPages` (default 1000) so a runaway cursor can never
   * spin forever. A non-positive `maxPages` (a computed 0 / negative) falls back
   * to the default bound rather than silently iterating nothing.
   *
   *   for await (const req of agreely.consentRequests.listAll()) { … }
   */
  async *listAll(
    input: ListAllConsentRequestsInput = {},
  ): AsyncGenerator<ConsentRequestRecord, void, unknown> {
    const maxPages = input.maxPages !== undefined && input.maxPages > 0 ? input.maxPages : DEFAULT_MAX_PAGES;
    let cursor = input.cursor;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.list({
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const item of result.items) yield item;
      if (result.nextCursor === null) return;
      cursor = result.nextCursor;
    }
  }

  /** Collect {@link listAll} into a single array (convenience). */
  async collect(input: ListAllConsentRequestsInput = {}): Promise<ConsentRequestRecord[]> {
    const out: ConsentRequestRecord[] = [];
    for await (const item of this.listAll(input)) out.push(item);
    return out;
  }

  /**
   * Poll GET /v1/consent-requests/{id} until it reaches a terminal state
   * (approved | refused | expired | revoked_before_action), or throw
   * AgreelyTimeoutError when the budget elapses. Honors Retry-After on a 429.
   *
   * Abortable via an AbortSignal: the abort is honored PROMPTLY (it interrupts the
   * inter-poll sleep immediately, not up to intervalMs later) and throws a DISTINCT
   * AgreelyAbortError (NOT AgreelyTimeoutError) so a caller can tell an intentional
   * cancellation from a budget timeout. Both carry the last-seen status.
   */
  async waitForSettlement(
    requestId: string,
    opts: WaitForSettlementOptions = {},
  ): Promise<ConsentRequestRecord> {
    const intervalMs = opts.intervalMs ?? 2000;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let lastStatus: ConsentRequestStatus | undefined;

    for (;;) {
      if (opts.signal?.aborted) {
        throw new AgreelyAbortError("waitForSettlement was aborted.", {
          ...(lastStatus !== undefined ? { lastStatus } : {}),
        });
      }

      let record: ConsentRequestRecord;
      try {
        record = await this.get(requestId);
      } catch (error) {
        // Honor a 429's Retry-After, then keep polling within the budget.
        if (error instanceof AgreelyRateLimitError) {
          const waitMs = (error.retryAfterSeconds ?? Math.ceil(intervalMs / 1000)) * 1000;
          if (Date.now() + waitMs >= deadline) {
            throw new AgreelyTimeoutError(
              `waitForSettlement timed out after ${String(timeoutMs)}ms while rate-limited.`,
              { ...(lastStatus !== undefined ? { lastStatus } : {}) },
            );
          }
          await this.sleepOrAbort(waitMs, opts.signal, lastStatus);
          continue;
        }
        throw error;
      }

      lastStatus = record.status;
      if (TERMINAL_STATUSES.has(record.status)) return record;

      if (Date.now() + intervalMs >= deadline) {
        throw new AgreelyTimeoutError(
          `waitForSettlement timed out after ${String(timeoutMs)}ms; last status "${record.status}".`,
          { lastStatus: record.status },
        );
      }
      await this.sleepOrAbort(intervalMs, opts.signal, lastStatus);
    }
  }

  /**
   * Sleep for `ms`, but wake and throw AgreelyAbortError the instant the signal
   * fires — so an abort is honored promptly, not only at the next poll tick.
   */
  private sleepOrAbort(
    ms: number,
    signal: AbortSignal | undefined,
    lastStatus: ConsentRequestStatus | undefined,
  ): Promise<void> {
    if (signal === undefined) return sleep(ms);
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer);
        reject(
          new AgreelyAbortError("waitForSettlement was aborted.", {
            ...(lastStatus !== undefined ? { lastStatus } : {}),
          }),
        );
      };
      if (signal.aborted) {
        abort();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

/** A unique Idempotency-Key per create call. crypto.randomUUID is global on Node 18+. */
function generateIdempotencyKey(): string {
  return `idem_${globalThis.crypto.randomUUID()}`;
}
