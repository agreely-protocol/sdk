import type { Transport } from "../transport.js";
import { recordIdempotencyKey } from "../util.js";
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
   * Override the auto-generated Idempotency-Key sent with the request: 1 to 255
   * printable ASCII characters, refused client-side otherwise.
   *
   * A retry with the same key AND the same body replays the original 201 and
   * records nothing new. The server binds the key to this endpoint and to the
   * request body: the same key with a different body is a NEW request (it records),
   * and a key spent on another endpoint never replays that endpoint's answer here.
   * Concurrent requests carrying the same key are processed one at a time.
   */
  idempotencyKey?: string;
}

export type { RecordOptions as ConsentRecordOptions };

/**
 * The manual / offline consent resource (scope: 'attest'). The company records a
 * consent it gathered out of band and attests to it under its own name; the
 * resulting enforcement records carry assurance "company_attested". Keyed on the
 * protocol consentRef (0x-hex), never an internal uuid.
 *
 * `revoke` also withdraws a VERBAL consent's cells, and accepts a key holding only
 * 'attest_verbal' (such a key reaches verbal refs only; any other ref is a 404).
 * `erase` needs 'attest'.
 */
export class ManualConsents {
  constructor(private readonly transport: Transport) {}

  /**
   * Record a company-attested consent. `items` names the consent ASKS ticked on the
   * sheet (catalog ids and/or raw {category, purpose} pairs, sent RAW and resolved
   * server-side) and may be EMPTY when every ask was answered "no". The server adds
   * every line the document gives for information as an acknowledgement (returned in
   * `acknowledged`) and ignores one sent in `items`. Evidence ALWAYS carries the
   * pdfSha256 commitment; the pdf bytes are uploaded only when explicitly provided.
   * NEVER auto-retried (it mutates).
   *
   * Refusals: 422 for a document that asks no consent (a collection notice), an empty
   * or non-PDF upload, a PDF that does not hash to pdfSha256, or an end past the
   * 10-year ceiling; 409 (AgreelyConflictError, code "conflict") when a purpose is
   * already held by an active passkey consent, or while a verbal consent for the same
   * customer and document awaits its paper. Nothing is recorded on a refusal.
   *
   * IDEMPOTENT on retry: an Idempotency-Key is auto-generated per call (overridable),
   * so a retry with the same key and body REPLAYS the original 201 (same consentId,
   * same consentRefs) and records NOTHING new.
   */
  record(input: RecordManualConsentInput, options: RecordOptions = {}): Promise<ManualConsentResult> {
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, "manualConsents.record");
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
   * the recorded attestation. Mutates (mints a token, retiring any live one for the
   * same customer); never auto-retried. A customerId the company holds no record of
   * is an AgreelyNotFoundError (nothing written); a relationship that has ended is an
   * AgreelyConflictError (code "conflict").
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

  /**
   * Withdraw a manual or verbal consent cell by its protocol consentRef (0x-hex).
   * Idempotent server-side; never auto-retried. Read `gate` for what /v1/check does
   * now: "superseded" means a later consent still backs the purpose. Withdrawing the
   * manual cell that confirmed a verbal one withdraws that verbal cell too; a verbal
   * ref whose paper already came back is a 409 (withdraw the manual ref instead,
   * see `verbalConsents.get`).
   */
  revoke(consentRef: string, input: ManualConsentMutationInput = {}): Promise<ManualConsentRevocation> {
    return this.transport.request<ManualConsentRevocation>({
      method: "POST",
      path: `/v1/manual-consents/${encodeURIComponent(consentRef)}/revoke`,
      body: { ...(input.reason !== undefined ? { reason: input.reason } : {}) },
      idempotentRetry: false,
    });
  }

  /**
   * Erase (crypto-shred) a manual or verbal consent cell by its protocol consentRef
   * (0x-hex). Scope 'attest' only: it cannot be undone. Idempotent server-side;
   * never auto-retried. A verbal ref whose paper already came back is a 409.
   */
  erase(consentRef: string, input: ManualConsentMutationInput = {}): Promise<ManualConsentErasure> {
    return this.transport.request<ManualConsentErasure>({
      method: "POST",
      path: `/v1/manual-consents/${encodeURIComponent(consentRef)}/erase`,
      body: { ...(input.reason !== undefined ? { reason: input.reason } : {}) },
      idempotentRetry: false,
    });
  }
}
