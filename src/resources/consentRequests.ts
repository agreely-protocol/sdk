import { AgreelyAbortError, AgreelyConfigError, AgreelyRateLimitError, AgreelyTimeoutError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  CancelledRequest,
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
  "asks_declined",
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
   * Issue a consent request under a PUBLISHED consent document (the Law 25
   * s. 8 disclosure). Exactly ONE of `consentDocumentId` / `documentCode` is
   * required; the requested items derive from the document server-side. NEVER
   * auto-retried (it emails): an Idempotency-Key is auto-generated per call
   * (overridable) so a caller-driven retry replays rather than double-issues.
   */
  create(input: CreateConsentRequestInput, options: CreateOptions = {}): Promise<IssuedRequest> {
    const hasId = typeof input.consentDocumentId === "string" && input.consentDocumentId.trim() !== "";
    const hasCode = typeof input.documentCode === "string" && input.documentCode.trim() !== "";
    if (!hasId && !hasCode) {
      throw new AgreelyConfigError(
        "consentRequests.create requires a consent document: pass consentDocumentId or documentCode.",
      );
    }
    if (hasId && hasCode) {
      throw new AgreelyConfigError(
        "consentRequests.create takes either consentDocumentId or documentCode, not both.",
      );
    }
    const idempotencyKey = options.idempotencyKey ?? generateIdempotencyKey();
    return this.transport.request<IssuedRequest>({
      method: "POST",
      path: "/v1/consent-requests",
      body: {
        customerId: input.customerId,
        recipientEmail: input.recipientEmail,
        validUntil: input.validUntil,
        ...(hasId ? { consentDocumentId: input.consentDocumentId } : {}),
        ...(hasCode ? { documentCode: input.documentCode } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * List the company's requests, newest first (keyset). All filters optional:
   * `customerId` (the company's own subject ref), `status` (note: "approved" never
   * includes "asks_declined", a request whose every consent ask was declined), `limit` (page size;
   * server default 50, max 100), and `cursor` (a requestId from a prior
   * `nextCursor`). Returns metadata only, tenant-scoped by the API key.
   */
  async list(input: ListConsentRequestsInput = {}): Promise<ConsentRequestPage> {
    const wire = await this.transport.request<ListWire>({
      method: "GET",
      path: "/v1/consent-requests",
      query: {
        customerId: input.customerId,
        status: input.status,
        limit: input.limit !== undefined ? String(input.limit) : undefined,
        cursor: input.cursor,
      },
      idempotentRetry: true,
    });
    // Coerce an absent nextCursor to null so listAll stops exactly like PHP's
    // fromWire does (the API always emits it; this keeps strict TS<->PHP parity).
    return { items: wire.requests, nextCursor: wire.nextCursor ?? null };
  }

  /**
   * The dedup helper: does an OPEN (still-pending) consent request already exist
   * for this customer? Lists status:'pending' for the customer (auto-paginating)
   * and returns true as soon as one is found, optionally narrowed to a specific
   * documentCode. Use it before consentRequests.create to avoid re-issuing (a
   * second email) when a request is already outstanding.
   *
   * Honest scope: this is a metadata convenience over the list endpoint, NOT a
   * compliance decision. It reports whether a pending request exists; it does not
   * assert consent was given.
   */
  async hasPending(customerId: string, documentCode?: string): Promise<boolean> {
    const ref = typeof customerId === "string" ? customerId.trim() : "";
    if (ref === "") {
      throw new AgreelyConfigError("consentRequests.hasPending requires a customerId.");
    }
    const wanted = typeof documentCode === "string" ? documentCode.trim() : "";
    for await (const req of this.listAll({ customerId: ref, status: "pending" })) {
      if (wanted === "" || req.documentCode === wanted) return true;
    }
    return false;
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
   * Cancel a still-PENDING request by its protocol requestId (0x + 64hex) — the
   * company-side "revoke before action" path. The request flips to the terminal
   * revoked_before_action status so its deep link no longer leads to an approval.
   *
   * IDEMPOTENT server-side: an already-terminal request is NOT an error — it
   * returns cancelled=false with its current status. Only a pending->cancelled
   * transition returns cancelled=true. An unknown/foreign id maps to
   * AgreelyNotFoundError (404). Never auto-retried (it mutates).
   */
  cancel(requestId: string): Promise<CancelledRequest> {
    return this.transport.request<CancelledRequest>({
      method: "POST",
      path: `/v1/consent-requests/${encodeURIComponent(requestId)}/cancel`,
      idempotentRetry: false,
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
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
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
   * (approved | asks_declined | refused | expired | revoked_before_action), or throw
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
