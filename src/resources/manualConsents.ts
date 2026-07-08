import type { Transport } from "../transport.js";
import type {
  ClaimLink,
  CreateClaimLinkInput,
  ManualConsentErasure,
  ManualConsentMutationInput,
  ManualConsentResult,
  ManualConsentRevocation,
  RecordManualConsentInput,
} from "../types.js";

interface RecordOptions {
  /**
   * Override the auto-generated Idempotency-Key sent with the request.
   *
   * WARNING: the server does NOT currently honor Idempotency-Key for
   * POST /v1/manual-consents (unlike consentRequests.create, which does). A
   * retried record may therefore create a DUPLICATE company-attested consent.
   * The header is sent (harmless, and forward-compatible if the server adds
   * support) but callers MUST guard against duplicate submits themselves.
   */
  idempotencyKey?: string;
}

/**
 * The manual / offline consent resource (scope: 'attest'). The company records a
 * consent it gathered out of band and attests to it under its own name; the
 * resulting enforcement records carry assurance "company_attested". Keyed on the
 * protocol consentRef (0x-hex), never an internal uuid.
 */
export class ManualConsents {
  constructor(private readonly transport: Transport) {}

  /**
   * Record a company-attested consent. Items are catalog ids and/or raw
   * {category, purpose} pairs, sent RAW and resolved server-side. Evidence
   * ALWAYS carries the pdfSha256 commitment; the pdf bytes are uploaded only when
   * explicitly provided. NEVER auto-retried (it mutates).
   *
   * IDEMPOTENCY CAVEAT: an Idempotency-Key is auto-generated per call (overridable)
   * and sent, but the server does NOT yet honor it for manual consents, so a
   * retried record CAN double-record. Guard against duplicate submits yourself.
   */
  record(input: RecordManualConsentInput, options: RecordOptions = {}): Promise<ManualConsentResult> {
    const idempotencyKey = options.idempotencyKey ?? generateIdempotencyKey();
    return this.transport.request<ManualConsentResult>({
      method: "POST",
      path: "/v1/manual-consents",
      body: {
        customerId: input.customerId,
        documentVersionId: input.documentVersionId,
        effectiveDate: input.effectiveDate,
        validUntil: input.validUntil,
        items: input.items,
        evidence: {
          pdfSha256: input.evidence.pdfSha256,
          ...(input.evidence.pdf !== undefined ? { pdf: input.evidence.pdf } : {}),
        },
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * Create a claim link the company hands to the subject so they can self-claim
   * the recorded attestation. Mutates (mints a token); never auto-retried.
   */
  createClaimLink(input: CreateClaimLinkInput): Promise<ClaimLink> {
    return this.transport.request<ClaimLink>({
      method: "POST",
      path: "/v1/manual-consents/claim-links",
      body: {
        customerId: input.customerId,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
      },
      idempotentRetry: false,
    });
  }

  /** Revoke a manual consent by its protocol consentRef (0x-hex). Idempotent server-side; never auto-retried. */
  revoke(consentRef: string, input: ManualConsentMutationInput = {}): Promise<ManualConsentRevocation> {
    return this.transport.request<ManualConsentRevocation>({
      method: "POST",
      path: `/v1/manual-consents/${encodeURIComponent(consentRef)}/revoke`,
      body: { ...(input.reason !== undefined ? { reason: input.reason } : {}) },
      idempotentRetry: false,
    });
  }

  /** Erase a manual consent by its protocol consentRef (0x-hex). Idempotent server-side; never auto-retried. */
  erase(consentRef: string, input: ManualConsentMutationInput = {}): Promise<ManualConsentErasure> {
    return this.transport.request<ManualConsentErasure>({
      method: "POST",
      path: `/v1/manual-consents/${encodeURIComponent(consentRef)}/erase`,
      body: { ...(input.reason !== undefined ? { reason: input.reason } : {}) },
      idempotentRetry: false,
    });
  }
}

/** A unique Idempotency-Key per record call. crypto.randomUUID is global on Node 18+. */
function generateIdempotencyKey(): string {
  return `idem_${globalThis.crypto.randomUUID()}`;
}
