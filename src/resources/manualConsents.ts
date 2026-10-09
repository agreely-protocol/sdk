import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import { assertOptions, recordIdempotencyKey, renderBudget, requireCustomerRef } from "../util.js";
import type {
  ClaimLink,
  ConsentSheet,
  ConsentSheetOptions,
  CreateClaimLinkInput,
  CreateConsentSheetInput,
  IdempotencyOptions,
  ManualConsentErasure,
  ManualConsentMutationInput,
  ManualConsentResult,
  ManualConsentRevocation,
  RecordManualConsentInput,
} from "../types.js";
import { DOCUMENT_TIMEOUT_MS, assertLocale } from "./consentDocuments.js";


/**
 * The manual / offline consent resource (scope: 'attest'). The company records a
 * consent it gathered out of band and attests to it under its own name; the
 * resulting enforcement records carry assurance "company_attested". Keyed on the
 * protocol consentRef (0x-hex), never an internal uuid.
 *
 * `revoke` also withdraws a VERBAL consent's cells, and accepts a key holding only
 * 'attest_verbal' (such a key reaches verbal refs only; any other ref is a 404).
 * `erase` needs 'attest'. Neither ever ends a consent the person signed with her
 * passkey: record her withdrawal with `withdrawals.record` (scope 'withdraw').
 */
export class ManualConsents {
  constructor(
    private readonly transport: Transport,
    private readonly clientTimeoutMs: number,
  ) {}

  /**
   * Record a company-attested consent. `items` names the consent ASKS ticked on the
   * sheet (catalog ids and/or raw {category, purpose} pairs, sent RAW and resolved
   * server-side) and may be EMPTY when every ask was answered "no". The server adds
   * every line the document gives for information as an acknowledgement (returned in
   * `acknowledged`) and ignores one sent in `items`. Evidence ALWAYS carries the
   * pdfSha256 commitment; the pdf bytes are uploaded only when explicitly provided.
   * NEVER auto-retried (it mutates).
   *
   * `sensitiveExpressAttested` and `versionAttested` are sent only when given, as JSON
   * booleans (anything else is refused client-side, never read as a yes).
   *
   * Refusals (compare `error.reason`): 422 for a document that asks no consent
   * (`notice_only`), an empty or non-PDF upload, a PDF that does not hash to pdfSha256
   * (`pdf_hash_mismatch`), an end past the 10-year ceiling (`valid_until_too_far`), an
   * `effectiveDate` in the future by any amount (`effective_date_in_future`), a sensitive
   * consent purpose without `sensitiveExpressAttested` (`sensitive_express_required`), a
   * paper signed before the version's publication without `versionAttested`
   * (`version_attestation_required`); 409 (AgreelyConflictError, code "conflict") when a
   * purpose is already held by a stronger consent (`stronger_consent_active`), the
   * relationship has ended (`relationship_ended`), or a verbal consent for the same
   * customer and document awaits its paper (`verbal_awaits_paper`). Nothing is recorded
   * on a refusal.
   *
   * IDEMPOTENT on retry: an Idempotency-Key is auto-generated per call (overridable),
   * so a retry with the same key and body REPLAYS the original 201 (same consentId,
   * same consentRefs) and records NOTHING new.
   */
  async record(input: RecordManualConsentInput, options: IdempotencyOptions = {}): Promise<ManualConsentResult> {
    assertOptions(options, ["idempotencyKey"], "manualConsents.record");
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
        ...optionalBoolean(input.sensitiveExpressAttested, "sensitiveExpressAttested"),
        ...optionalBoolean(input.versionAttested, "versionAttested"),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * Print the SIGNATURE SHEET of one published version for one customer, minted with a
   * NEW claim the person may redeem later (POST /v1/customers/{customerRef}/consent-sheets,
   * scope 'attest'). The sheet carries a printed reference, the claim's second factor.
   *
   * RETURNED ONCE. The printed reference and the claim token are stored nowhere: no later
   * call recovers them, and a retry with the same Idempotency-Key is a 409
   * `already_minted` that mints nothing. A new sheet retires the claim of the previous
   * one, so the reference printed on it stops working.
   *
   * NEVER deliver `claim.claimUrl` in the same message or envelope as the sheet, and
   * NEVER send this BLANK sheet's hash as `evidence.pdfSha256`: the evidence of the
   * consent is the SIGNED paper, recorded with `record` once it comes back.
   *
   * Refusals: 404 `unknown_customer` (nothing written); 422 `invalid_document` (not a
   * published version of yours) or code `no_consent_ask` with reason `notice_only` (the
   * version asks nothing, so there is nothing to sign); 409 `relationship_ended`. Never
   * auto-retried; its time budget defaults to at least 15 s (the server renders the PDF).
   */
  async createConsentSheet(
    customerRef: string,
    input: CreateConsentSheetInput,
    options: ConsentSheetOptions = {},
  ): Promise<ConsentSheet> {
    const label = "manualConsents.createConsentSheet";
    assertOptions(options, ["idempotencyKey", "timeout"], label);
    const ref = requireCustomerRef(customerRef, label);
    const documentVersionId = typeof input.documentVersionId === "string" ? input.documentVersionId.trim() : "";
    if (documentVersionId === "") {
      throw new AgreelyConfigError(`${label} requires the documentVersionId of a published version.`);
    }
    // The body is closed server-side (any other member is a 422), so it is built from the two named fields only.
    return this.transport.request<ConsentSheet>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(ref)}/consent-sheets`,
      body: { documentVersionId, locale: assertLocale(input.locale, label) },
      headers: { "Idempotency-Key": recordIdempotencyKey(options.idempotencyKey, label) },
      idempotentRetry: false,
      timeoutMs: renderBudget(options.timeout, this.clientTimeoutMs, DOCUMENT_TIMEOUT_MS, label),
    });
  }

  /**
   * Create a claim link the company hands to the subject so they can self-claim
   * the recorded attestation. Mutates (mints a token, retiring any live one for the
   * same customer); never auto-retried. A customerId the company holds no record of
   * is an AgreelyNotFoundError (nothing written); a relationship that has ended is an
   * AgreelyConflictError (code "conflict").
   */
  async createClaimLink(input: CreateClaimLinkInput): Promise<ClaimLink> {
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
   * ref whose paper already came back is a 409 `superseded_by_paper` (withdraw the
   * manual ref instead, see `verbalConsents.get`). A 409 `citizen_consent_at_gate` means
   * a consent the person signed with her passkey holds the purpose: this route never
   * ends one, record her withdrawal with `withdrawals.record` instead.
   */
  async revoke(consentRef: string, input: ManualConsentMutationInput = {}): Promise<ManualConsentRevocation> {
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
   * never auto-retried. Returns `gate` like `revoke`. A verbal ref whose paper already
   * came back is a 409 `superseded_by_paper`; a purpose held by a passkey consent is a
   * 409 `citizen_consent_at_gate`.
   */
  async erase(consentRef: string, input: ManualConsentMutationInput = {}): Promise<ManualConsentErasure> {
    return this.transport.request<ManualConsentErasure>({
      method: "POST",
      path: `/v1/manual-consents/${encodeURIComponent(consentRef)}/erase`,
      body: { ...(input.reason !== undefined ? { reason: input.reason } : {}) },
      idempotentRetry: false,
    });
  }
}

/** A strict JSON boolean member, sent only when given. Anything else is refused, never coerced. */
function optionalBoolean<K extends string>(value: unknown, key: K): Partial<Record<K, boolean>> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new AgreelyConfigError(`manualConsents.record: ${key} must be a boolean.`);
  }
  return { [key]: value } as Partial<Record<K, boolean>>;
}
