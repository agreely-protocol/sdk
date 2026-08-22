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
   * The server HONORS this for POST /v1/manual-consents (since 2026-07-01), exactly
   * like consentRequests.create: a retry with the same key replays the original 201
   * and records nothing new.
   *
   * The KEY is the whole contract: the replay is keyed on (company, key) alone, NOT
   * on the request body and NOT on the endpoint. Reusing a key with a different
   * payload silently replays the FIRST payload and writes nothing, and a key already
   * spent on consentRequests.create will replay THAT response here. Leave this unset
   * unless you have a durable, operation-unique id.
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
   * IDEMPOTENT on retry: an Idempotency-Key is auto-generated per call (overridable)
   * and the server HONORS it, so a retry with the same key REPLAYS the original 201
   * body (same consentId, same consentRefs) and records NOTHING new. A dropped
   * connection can never double-attest a consent. See RecordOptions.idempotencyKey
   * for the one caveat: keys are scoped to the company, not to the body or endpoint.
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
