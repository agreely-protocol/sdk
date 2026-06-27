import type { Transport } from "../transport.js";
import type {
  ConsentRequestPage,
  ConsentRequestRecord,
  CreateConsentRequestInput,
  IssuedRequest,
  ListConsentRequestsInput,
} from "../types.js";

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
    return { items: wire.requests, nextCursor: wire.nextCursor };
  }

  /** Fetch one request by its protocol requestId (0x + 64hex). */
  get(requestId: string): Promise<ConsentRequestRecord> {
    return this.transport.request<ConsentRequestRecord>({
      method: "GET",
      path: `/v1/consent-requests/${encodeURIComponent(requestId)}`,
      idempotentRetry: true,
    });
  }
}

/** A unique Idempotency-Key per create call. crypto.randomUUID is global on Node 18+. */
function generateIdempotencyKey(): string {
  return `idem_${globalThis.crypto.randomUUID()}`;
}
