// The wire types of the Agreely /v1 API, mirrored 1:1 from the committed
// openapi.yaml. These shapes are load-bearing (anti-drift, like the Phase-2
// crypto vectors): the contract tests assert real responses against them.

/** A consent decision. ALLOW is the only true. */
export type Decision = "allow" | "deny";

/**
 * A /v1 API-key scope: 'check' (the synchronous check), 'issue' (consent-request
 * issuance + reads), 'attest' (manual / offline consent recording, the paper of a
 * verbal consent, withdrawal and erasure), 'attest_verbal' (recording a consent given
 * by telephone; never granted by default, and it withdraws VERBAL consents only),
 * 'relationship' (ending a customer relationship, art. 23), 'registry' (the
 * customer registry; no SDK resource wraps it yet), 'retention' (read the decided
 * retention rules and catalogue cells, declare purges and passes) and 'inventory'
 * (declare a host system's record sets and read their retention statements).
 *
 * FORWARD COMPATIBILITY: the server may add scopes, and `identity()` returns them
 * as it receives them, so a value outside this union can reach you at runtime.
 */
export type Scope =
  | "check"
  | "issue"
  | "attest"
  | "attest_verbal"
  | "relationship"
  | "registry"
  | "retention"
  | "inventory";

/**
 * The least-disclosure identity of the presented key, from GET /v1/whoami: the
 * key's own scopes, and the minimum needed to DISCOVER the tenant instead of
 * hard-coding it. Deliberately no company id, no DID, no key metadata, and
 * nothing about the tenant's size, plan, usage or billing state.
 */
export interface Identity {
  /** The presented key's scopes, exactly as the server reports them. */
  scopes: Scope[];
  company: {
    name: string;
    sector: Regime["sector"];
    statute: Regime["statute"];
    /** The ABSOLUTE url of the tenant's public privacy page, or null when it would not resolve. */
    publicPolicyUrl: string | null;
  };
}

/**
 * How the consent behind a decision was established, strongest first:
 *   "citizen_signed"     -> the person signed it themselves with a passkey (tier "full")
 *   "company_attested"   -> the organisation recorded a hand-signed paper (tier "manual")
 *   "company_documented" -> the person consented BY TELEPHONE and the organisation
 *                           documented it, with no document at all (tier "verbal")
 *
 * Present on a check whenever a CONSENT backs the decision. Absent for "none", for
 * "necessity" and for a line the document gave for information (an acknowledgement is
 * no consent at any tier). The HOST decides which assurance a use may accept: treat
 * any value you do not recognise as NOT acceptable.
 */
export type Assurance = "citizen_signed" | "company_attested" | "company_documented";

/**
 * The same proof tier as {@link Assurance}, under its stored name: "full" (passkey) >
 * "manual" (paper) > "verbal" (telephone). Present exactly when `assurance` is.
 */
export type Tier = "full" | "manual" | "verbal";

/**
 * The resolved status of an enforcement cell: the NINE-value vocabulary of
 * openapi.yaml (CheckDecision.status / BatchDecision.status).
 *
 * ALLOW:
 *   "active"    -> a live consent record backs the cell (carries consentRef + assurance + tier).
 *   "necessity" -> allow WITHOUT a signed consent record: there is no per-subject
 *     record, but the active catalog cell declares a NON-consent ground that the act
 *     governing the tenant lets it use the cell on. Carries `basis` and NO
 *     consentRef/assurance/tier (there is no signed proof), and the check CREATES
 *     NOTHING. Never present a necessity allow to a person or an auditor as
 *     "consented". A cell declared SENSITIVE answers by its basis like any other: on a
 *     non-consent ground it allows "necessity", on `consent` it denies "none".
 *
 *   A line the document gave FOR INFORMATION and the person acknowledged is not a
 *   consent: it answers exactly like no record (necessity + basis, or the usual
 *   refusal), with NO consentRef and NO assurance/tier. Once that acknowledgement is
 *   withdrawn it answers deny "revoked" WITH a consentRef but still no assurance/tier.
 *
 * DENY:
 *   "none"      -> no record on a consent-basis cell (or no active catalog cell).
 *     Consent must refuse without a record. This is ALSO what an erased cell reads as.
 *   "revoked"   -> the consent was withdrawn (art. 14).
 *   "expired"   -> the consent lifespan elapsed (art. 14 al. 3).
 *   "erased"    -> listed by openapi.yaml, but NOT currently emitted by the API.
 *     Erasure is a crypto-shred: it DELETES the enforcement record outright (art. 23),
 *     so an erased cell reads back as deny/"none". Kept in the union so an exhaustive
 *     switch stays spec-complete; do not expect it on the wire today.
 *   "relationship_ended" -> the company attested the relationship is over (art. 23), a
 *     prospective relationship-level stop; the per-cell consent stays truthfully active
 *     (it was never withdrawn), which is why this is its own status.
 *   "requires_depersonalization" -> the cell declares a ground the tenant's act carries
 *     ONLY for depersonalized information (A-2.1 art. 65.1 al. 2 (4 deg)), which cannot be
 *     met for a named customer at the gate. It is NOT "no consent on record", and it
 *     must not be answered by collecting a consent.
 *   "basis_not_in_regime" -> the cell declares a ground the tenant's act does not carry
 *     at all (typically left in the other sector's vocabulary after a sector change).
 *     The fix is a catalog re-declaration by the tenant.
 *
 * REMOVED in 0.4.0: "sensitive_requires_consent". The API stopped emitting it on
 * 2026-09-28; a sensitive cell now answers by its declared basis (see "necessity").
 *
 * FORWARD COMPATIBILITY: the server may add statuses, and a value outside this union
 * can reach you at runtime (nothing is validated on decode). Treat ANY unrecognised
 * status as a DENY and read `decision`, which is only ever "allow" or "deny".
 */
export type Status =
  | "active"
  | "necessity"
  | "none"
  | "revoked"
  | "expired"
  | "erased"
  | "relationship_ended"
  | "requires_depersonalization"
  | "basis_not_in_regime";

/**
 * The DECLARED non-consent ground behind a `status: "necessity"` allow. Present
 * ONLY on a necessity allow; absent on every other status. The value set is
 * SECTOR-KEYED and the two halves are disjoint: read `company.sector` from
 * `identity()` (or `regime` from `catalog.listCells()`) before switching on it.
 *
 * Agreely records the company's DECLARED basis and does NOT certify its legal validity.
 * A necessity allow carries no consent artifact.
 *
 * Private enterprises (P-39.1), as openapi.yaml cites them:
 *   "contract"              -> art. 9 al. 1 (1 deg)
 *   "necessary_for_service" -> art. 12 al. 2 (4 deg), supply of a product or service
 *   "security_fraud"        -> art. 12 al. 2 (3 deg)
 *   "legal_obligation"      -> art. 23 al. 1 in fine, art. 18 al. 1 (4 deg) and (6 deg)
 *   "professional_contact"  -> art. 1 al. 5. NOTE: a SCOPE CARVE-OUT from Divisions II
 *     and III of the Act, not a necessity ground. It appears here because it also
 *     produces a necessity allow.
 *
 *
 * Public bodies (A-2.1):
 *   "attributions" / "programme" / "entente_collecte" -> collected under art. 64,
 *     used under art. 65.1 al. 1
 *   "compatible_use"   -> art. 65.1 al. 2 (1 deg)
 *   "manifest_benefit" -> art. 65.1 al. 2 (2 deg)
 *   "law_application"  -> art. 65.1 al. 2 (3 deg)
 *   "public_character" -> art. 55 al. 1 with art. 57, again a SCOPE CARVE-OUT.
 *
 * "depersonalized_research" is deliberately absent: it never produces an allow at the
 * gate (see status "requires_depersonalization").
 */
export type Basis =
  // Private enterprises (P-39.1)
  | "contract"
  | "necessary_for_service"
  | "security_fraud"
  | "legal_obligation"
  | "professional_contact"
  // Public bodies (A-2.1)
  | "attributions"
  | "programme"
  | "entente_collecte"
  | "compatible_use"
  | "manifest_benefit"
  | "law_application"
  | "public_character";

/** The full result of a check. `check()` returns the boolean; this is the reasoned form. */
export interface CheckResult {
  decision: Decision;
  status: Status;
  /**
   * 0x-hex enforcement handle. Present for every status backed by a record; absent
   * for "none" and "necessity" (including an acknowledged information line that
   * still stands).
   */
  consentRef?: string;
  /** ISO-8601 timestamp the decision was made at. */
  checkedAt: string;
  /**
   * How the consent behind the decision was established. Present whenever a
   * CONSENT backs it; absent for "none", "necessity", an acknowledged information
   * line (even once withdrawn), and never set on a degraded (synthesized) result.
   */
  assurance?: Assurance;
  /** The same proof tier as `assurance` ("full" | "manual" | "verbal"); present exactly when it is. */
  tier?: Tier;
  /**
   * The DECLARED non-consent lawful basis behind a `status: "necessity"` allow.
   * Present ONLY when status is "necessity"; absent for every other status, and
   * never set on a degraded (synthesized) result. Agreely records the company's
   * declared basis, it does not certify its legal validity.
   */
  basis?: Basis;
  /**
   * True when this result did NOT come from the server but from the local
   * degrade policy (fail-open / break-glass) during an outage. Never set on a
   * real server decision.
   */
  degraded?: boolean;
  /** The degrade mode that produced a degraded allow, when `degraded` is true. */
  mode?: DegradeMode;
}

/** One item for a batch check. */
export interface BatchCheckItem {
  customerRef: string;
  category: string;
  purpose: string;
}

/** The decision for one item in a batch check response. */
export interface BatchDecision {
  customerRef: string;
  category: string;
  purpose: string;
  decision: Decision;
  status: Status;
  /** 0x-hex enforcement handle. Present for every status backed by a record; absent for "none" and "necessity". */
  consentRef?: string;
  /**
   * How the consent behind the decision was established. Present whenever a
   * CONSENT backs it; absent for "none", "necessity" and an acknowledged
   * information line (even once withdrawn).
   */
  assurance?: Assurance;
  /** The same proof tier as `assurance` ("full" | "manual" | "verbal"); present exactly when it is. */
  tier?: Tier;
  /**
   * The DECLARED non-consent lawful basis behind a `status: "necessity"` allow.
   * Present ONLY when status is "necessity".
   */
  basis?: Basis;
  /** ISO-8601 timestamp the decision was made at. */
  checkedAt: string;
}

/**
 * The result of checkFields: a pre-built lookup for a (customerRef, category,
 * purpose) cartesian product. Use `isAllowed` to gate field display.
 */
export interface CheckFieldsResult {
  /** The raw decisions array from the server (aligned to the flattened items). */
  decisions: BatchDecision[];
  /**
   * Boolean gate. Returns true ONLY when the decision for this exact
   * (customerRef, category, purpose) triple is "allow". Strings are compared
   * as submitted to checkFields (the server normalizes; the SDK sends raw).
   */
  isAllowed(customerRef: string, category: string, purpose: string): boolean;
}

/** One (category, purpose) label pair, as the server echoes it back. */
export interface ItemLabels {
  category: string;
  purpose: string;
}

/**
 * An item to request consent for: either a catalog entry id (string) OR a raw
 * {category, purpose} pair. Pairs are resolved server-side to the company's
 * declared active catalog — the SDK sends them raw and NEVER normalizes.
 */
export type IssueItem = string | { category: string; purpose: string };

/**
 * Input for issuing a consent request. Every request is issued under a
 * PUBLISHED consent document (the Law 25 s. 8 disclosure): exactly ONE of
 * `consentDocumentId` / `documentCode` is required. The requested (category,
 * purpose) items derive from the document server-side — there is no caller
 * items list.
 */
export interface CreateConsentRequestInput {
  customerId: string;
  recipientEmail: string;
  /** The published consent document VERSION id to issue under. */
  consentDocumentId?: string;
  /** A document code; the server resolves the currently-published version. */
  documentCode?: string;
  /**
   * The consent's end if approved: a plain date (YYYY-MM-DD, meaning the END of that
   * calendar day in the tenant's timezone) or an RFC 3339 instant WITH an offset.
   * Relative phrases ("+1 year") are refused, and so is an end more than 10 years
   * after the start (an Agreely product ceiling, not a statutory one).
   */
  validUntil: string;
}

/**
 * The bound consent document snapshot (code, name, version) the signed offer
 * commits to.
 */
export interface ConsentDocumentDescriptor {
  code: string;
  name: string;
  version: string;
}

/** The 201 body from issuance (or an idempotent replay of it). */
export interface IssuedRequest {
  /** The protocol handle (0x-prefixed 64-hex). The public identifier. */
  requestId: string;
  status: "pending";
  /** The recipient's secure approval link. */
  deepLink: string;
  emailDelivered: boolean;
  items: ItemLabels[];
  /** The published consent document the request was issued under. */
  document: ConsentDocumentDescriptor;
}

/**
 * The EFFECTIVE status of a consent request.
 *
 *   "approved"      -> the person confirmed and, when the request carried consent asks,
 *                      accepted AT LEAST ONE of them.
 *   "asks_declined" -> the person confirmed only her receipt of the lines given for
 *                      information and declined EVERY consent ask: no consent was
 *                      obtained. Never returned as (nor filtered under) "approved".
 *   "pending" / "refused" / "expired" / "revoked_before_action" as before; a pending
 *   request past its answer deadline reads "expired".
 */
export type ConsentRequestStatus =
  | "pending"
  | "approved"
  | "asks_declined"
  | "refused"
  | "expired"
  | "revoked_before_action";

/** A consent request record as returned by list/get. */
export interface ConsentRequestRecord {
  /** The protocol requestId (0x-prefixed 64-hex), NOT an internal uuid. */
  requestId: string;
  status: ConsentRequestStatus;
  validUntil: string;
  expiresAt: string;
  createdAt: string;
  settledAt: string | null;
  /** The company's OWN subject reference the request was issued for. */
  customerId: string;
  /** The code of the consent document the request was issued under (metadata). */
  documentCode: string;
  items: ItemLabels[];
  /** Null only on legacy rows issued before the document became mandatory. */
  document: ConsentDocumentDescriptor | null;
}

/**
 * The 200 body from POST /v1/consent-requests/{id}/cancel. `cancelled` is true
 * only when THIS call flipped a pending request to revoked_before_action; false
 * on an idempotent no-op against an already-terminal request (not an error).
 * `status` is the request's status AFTER the call.
 */
export interface CancelledRequest {
  /** The protocol requestId (0x-prefixed 64-hex). */
  requestId: string;
  status: ConsentRequestStatus;
  cancelled: boolean;
}

export interface ListConsentRequestsInput {
  /** Filter to one company subject reference (the company's own customerId). */
  customerId?: string;
  status?: ConsentRequestStatus;
  /** Page size (server default 50, max 100). */
  limit?: number;
  /** The requestId to page after (from a prior `nextCursor`). */
  cursor?: string;
}

/** Options for the auto-paginating listAll/collect. */
export interface ListAllConsentRequestsInput {
  /** Filter to one company subject reference (the company's own customerId). */
  customerId?: string;
  status?: ConsentRequestStatus;
  /** Page size per underlying request (server default 50, max 100). */
  limit?: number;
  /** Start paging after this requestId (a prior `nextCursor`). */
  cursor?: string;
  /** Hard guard on pages fetched (default 1000) so a runaway cursor can't spin forever. */
  maxPages?: number;
}

/** Options for waitForSettlement. */
export interface WaitForSettlementOptions {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** Total wait budget in ms before AgreelyTimeoutError. Default 120000. */
  timeoutMs?: number;
  /** Abort the wait (throws AgreelyTimeoutError with the last-seen status). */
  signal?: AbortSignal;
}

/**
 * A page of consent requests. Note the SDK surfaces `items` (the server wire
 * field is `requests`); `nextCursor` is null when the list is exhausted.
 */
export interface ConsentRequestPage {
  items: ConsentRequestRecord[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Manual / offline (company-attested) consent. The company records a consent it
// gathered out of band (a signed paper/PDF), attesting to it under its own name.
// The result carries assurance "company_attested" (vs the citizen-signed path).
// ---------------------------------------------------------------------------

/**
 * The evidence for a manual consent (or for the paper of a verbal one). `pdfSha256`
 * is ALWAYS sent (the integrity commitment, "0x" + 64 lowercase hex of the source
 * PDF; `Agreely.hashPdf` computes it). `pdf` is an OPTIONAL opt-in upload of the
 * document bytes (base64); omit it to keep the file local and commit only to its hash
 * (data minimization).
 *
 * Refused with a 422: an uploaded file that is empty or is not a PDF (no "%PDF-"
 * header), the SHA-256 of zero bytes, and an upload whose bytes do not hash to
 * `pdfSha256`.
 */
export interface ManualConsentEvidence {
  /** "0x" + 64 hex SHA-256 of the source PDF. Required. */
  pdfSha256: string;
  /** Optional base64 of the PDF bytes (opt-in upload). Omit to stay minimal. */
  pdf?: string;
}

export interface RecordManualConsentInput {
  customerId: string;
  /**
   * The published document version the customer signed. A document that asks no
   * consent at all (a collection notice) is refused with a 422.
   */
  documentVersionId: string;
  /** When the consent took effect (ISO date, e.g. the signature date). */
  effectiveDate: string;
  /**
   * The consent's end: a plain date (the END of that calendar day in the tenant's
   * timezone) or an RFC 3339 instant with an offset. Relative phrases are refused, and
   * so is an end more than 10 years after the start (an Agreely product ceiling).
   */
  validUntil: string;
  /**
   * The consent ASKS ticked on the sheet, as catalog entry ids and/or {category,
   * purpose} pairs. MAY BE EMPTY: every ask answered "no" (the record then holds only
   * the acknowledged information lines, and `asksDeclined` is true). The lines the
   * document gives for information are added by the server as acknowledgements; one
   * sent here is ignored.
   */
  items: IssueItem[];
  evidence: ManualConsentEvidence;
}

/**
 * A line the document gave FOR INFORMATION, recorded as the person's acknowledgement
 * and never as a consent. /v1/check answers it by its declared basis.
 */
export interface AcknowledgedLine {
  category: string;
  purpose: string;
  /** Its own enforcement handle (withdraw or erase it like any cell). */
  consentRef: string;
}

/** The 201 body from recording a manual consent. */
export interface ManualConsentResult {
  /** The internal consent id for the recorded attestation. */
  consentId: string;
  /** The merkle root committing to the recorded cells. */
  merkleRoot: string;
  /** One 0x-hex enforcement handle per recorded cell, acknowledged information lines included. */
  consentRefs: string[];
  /** Always "company_attested" for the manual path. */
  assurance: "company_attested";
  /** Whether the attestation is already anchored on-chain (false at record time). */
  anchored: boolean;
  /** The information lines recorded as acknowledged (never consents). */
  acknowledged: AcknowledgedLine[];
  /** True when no consent ask is on the record (every ask answered "no"); only the acknowledgement was recorded. */
  asksDeclined: boolean;
}

export interface CreateClaimLinkInput {
  customerId: string;
  /** An optional company-side reference to stamp on the claim. */
  reference?: string;
}

/** A claim link the company hands to the subject to self-claim the attestation. */
export interface ClaimLink {
  claimUrl: string;
  token: string;
  expiresAt: string;
}

/** Options for revoking/erasing a manual consent by its consentRef. */
export interface ManualConsentMutationInput {
  /** An optional operator reason recorded with the mutation. */
  reason?: string;
}

/**
 * What /v1/check does NOW for the withdrawn purpose:
 *   "denied"     -> this consent backed the gate, and the gate now denies.
 *   "superseded" -> a later consent for the same purpose had already taken the gate
 *                   over; the withdrawal is recorded and that later consent is untouched
 *                   (so the gate may still ALLOW).
 *   "unchanged"  -> an idempotent repeat (`alreadyRevoked: true`).
 */
export type RevocationGate = "denied" | "superseded" | "unchanged";

/** The 200 body from revoking a manual or verbal consent. */
export interface ManualConsentRevocation {
  consentRef: string;
  revoked: boolean;
  /** True when the consent was already revoked (the call is idempotent). */
  alreadyRevoked: boolean;
  /** What the gate does now. Read this, not `revoked`, before telling anyone the use stopped. */
  gate: RevocationGate;
}

/** The 200 body from erasing a manual consent. */
export interface ManualConsentErasure {
  consentRef: string;
  erased: boolean;
  /** True when the consent was already erased (the call is idempotent). */
  alreadyErased: boolean;
}

// ---------------------------------------------------------------------------
// Verbal consent (issue #100): a consent given BY TELEPHONE and documented by the
// organisation. The WEAKEST of three tiers (full > manual > verbal): there is no
// document at all, so the proof is the organisation's word. Every result says
// tier "verbal" / assurance "company_documented", never "signed" or "validated".
// ---------------------------------------------------------------------------

/**
 * The person's own answer to one consent ask put on the call, exactly "yes" or "no".
 * A purpose is never consented by default, and a line the document gives for
 * information is never answered (sending one is a 422).
 */
export interface VerbalAnswer {
  category: string;
  purpose: string;
  answer: "yes" | "no";
}

/**
 * In what capacity a representative answered. The last two name who consents for a
 * MINOR under 14 and are never interchangeable with the adult measures.
 */
export type RepresentativeCapacity =
  | "tutelle"
  | "mandat_protection_homologue"
  | "representation_temporaire"
  | "curatelle"
  | "other"
  | "undeclared"
  | "titulaire_autorite_parentale"
  | "tuteur_mineur";

/** Who answered the call. */
export interface VerbalRespondent {
  consentedBy: "self" | "self_with_assistant" | "representative";
  /** Required for a representative, and only for one ("undeclared" is an honest answer). */
  representativeCapacity?: RepresentativeCapacity;
  /**
   * For a minor under 14 only, and then required: the titulaire de l'autorité parentale
   * or the tuteur who answered (at most 128 bytes). Stored encrypted.
   */
  name?: string;
}

export interface RecordVerbalConsentInput {
  /** The company's own reference for the person (never a citizen DID). */
  customerId: string;
  /** The published consent-document version the call was held against (its grid bounds the purposes). */
  documentVersionId: string;
  /**
   * Each consent ask put on the call, answered, each purpose once. At least one "yes"
   * unless the document has lines to acknowledge (then every "no" still records the
   * acknowledgement and `asksDeclined` comes back true). Never a line given for information.
   */
  answers: VerbalAnswer[];
  /**
   * The instant of the call (the consent date): a Date, or RFC 3339 WITH an offset. Not
   * in the future (5 minutes of skew allowed) and at most 7 days old.
   */
  obtainedAt: Instant;
  /** The staff member who took the call, as the organisation names them (1 to 128 bytes). Stored encrypted. */
  obtainedBy: string;
  /** The organisation's version label of the script read aloud (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`). */
  scriptVersion: string;
  respondent: VerbalRespondent;
  /**
   * The consent's end: a plain date (the END of that calendar day in the tenant's
   * timezone), or a Date / RFC 3339 instant with an offset. After the call and in the
   * future; relative phrases are refused; at most 10 years (an Agreely product ceiling).
   */
  validUntil: string | Date;
  /**
   * Must be true when any "yes" purpose is declared sensitive AND rests on the `consent`
   * basis: the organisation attests the consent was given expressly.
   */
  sensitiveExpressAttested?: boolean;
  /**
   * The person concerned is a minor under 14. The respondent must then be a representative
   * in the capacity "titulaire_autorite_parentale" or "tuteur_mineur", named in `respondent.name`.
   */
  isMinor?: boolean;
  /**
   * The organisation expects the signed paper back. An attribute, never a tier: if the
   * paper never returns, the consent stays recorded at tier "verbal" and does not lapse.
   */
  paperExpected?: boolean;
}

/** The 201 body from recording a verbal consent (or an idempotent replay of it). */
export interface VerbalConsentResult {
  consentId: string;
  /** 0x-hex Merkle root over the per-cell commitments (anchored like any consent). */
  merkleRoot: string;
  /** The per-cell 0x-hex consentRefs of the "yes" purposes and the acknowledged lines. */
  consentRefs: string[];
  tier: "verbal";
  /** Always "company_documented"; never overstated. */
  assurance: "company_documented";
  /** False at record time; the on-chain anchor lands asynchronously. */
  anchored: boolean;
  paperExpected: boolean;
  /** The information lines, recorded as acknowledged from the script, never as consents. */
  acknowledged: AcknowledgedLine[];
  /** True when every ask was answered "no"; only the acknowledgement was recorded. */
  asksDeclined: boolean;
}

export interface ConfirmVerbalPaperInput {
  /**
   * The instant the paper was signed (the evidence date): a Date, or RFC 3339 WITH an
   * offset. No earlier than the call and not in the future.
   */
  signedAt: Instant;
  /**
   * EXACTLY the purposes still consented by telephone, each once, as ticked on the paper.
   * A "no" is recorded as a withdrawal dated at `signedAt`. A purpose first consented on
   * paper is a new consent: record it with `manualConsents.record`.
   */
  answers: VerbalAnswer[];
  /** The signed paper. Same rules as a manual consent's evidence (a real, non-empty PDF). */
  evidence: ManualConsentEvidence;
}

/** The 201 body from recording the signed paper of a verbal consent (the rise to manual). */
export interface VerbalPaperResult {
  verbalConsentId: string;
  /** The new manual consent, or null when every box came back unticked. */
  manualConsentId: string | null;
  /** The manual consent's own 0x-hex Merkle root, or null. */
  merkleRoot: string | null;
  tier: "manual" | null;
  /** Each purpose ticked on the paper: the verbal cell it confirms and the new manual cell the gate now reads. */
  confirmed: Array<{ category: string; purpose: string; verbalConsentRef: string; consentRef: string }>;
  /** The purposes unticked on the paper, withdrawn as of `signedAt`. */
  withdrawn: Array<{ category: string; purpose: string; consentRef: string }>;
}

/** Where a verbal consent is in its life. */
export type VerbalConsentState = "awaiting_paper" | "verbal_only" | "paper_received";

/** One purpose of a verbal consent's history. */
export interface VerbalHistoryPurpose {
  category: string | null;
  purpose: string | null;
  /** "informed" is a line given for information, acknowledged from the script and never answered. */
  answer: "yes" | "no" | "informed";
  consentRef: string | null;
  status: "active" | "revoked" | "expired" | "erased" | null;
  paper: "confirmed_on_paper" | "withdrawn_on_paper" | null;
  /** The manual cell that confirmed this one on paper, when there is one. */
  confirmedBy: { consentRef: string; status: string } | null;
}

/** The body of GET /v1/verbal-consents/{consentId}: what was said, what the paper said, what is in force. */
export interface VerbalConsentHistory {
  consentId: string;
  /** Kept forever: the verbal consent never becomes another tier (the paper mints a NEW manual consent). */
  tier: "verbal";
  assurance: "company_documented";
  merkleRoot: string;
  anchored: boolean;
  /** The instant of the call, the consent date. */
  obtainedAt: string;
  /** When Agreely recorded it. The gap to obtainedAt is shown on purpose. */
  recordedAt: string;
  obtainedBy: string | null;
  scriptVersion: string;
  documentVersionId: string;
  validUntil: string;
  paperExpected: boolean;
  state: VerbalConsentState;
  purposes: VerbalHistoryPurpose[];
  paper: {
    /** The evidence date, distinct from obtainedAt. */
    signedAt: string;
    recordedAt: string;
    pdfSha256: string;
    manualConsentId: string | null;
    manualMerkleRoot: string | null;
    tier: "manual" | null;
  } | null;
}

// ---------------------------------------------------------------------------
// End of a customer relationship (Law 25 art. 23, "les fins sont accomplies").
// A pure lifecycle OVERLAY keyed on the company's OWN customerRef — never a DID.
// ---------------------------------------------------------------------------

/** Input for ending a customer relationship. */
export interface EndRelationshipInput {
  /** The company's own reference for the customer (the same ref used by check). */
  customerRef: string;
  /** The art. 23 justification. Required: a blank reason fails closed client-side. */
  reason: string;
}

/**
 * The 200 body from POST /v1/customers/{customerRef}/relationship/end. Company-
 * side facts only: the customer's own ref, the terminal lifecycle, when it ended
 * and the recorded ORIGIN of the wind-down. NEVER a DID or a consent_ref.
 */
export interface RelationshipEnded {
  customerRef: string;
  /** The terminal lifecycle after the call. */
  status: "ended";
  /** ISO-8601 timestamp the relationship was first ended (preserved on a re-end). */
  endedAt: string;
  /**
   * The recorded origin: "company" for a company-initiated end; "citizen_request"
   * is preserved when a citizen close-account request had already begun the ending
   * (the origin is never overwritten).
   */
  endedBy: "company" | "citizen_request";
}

/** Input for reverting a mistaken end of a customer relationship (art. 11 / art. 28). */
export interface RevertRelationshipInput {
  /** The company's own reference for the customer (the same ref used by check). */
  customerRef: string;
  /** The art. 11 / art. 28 correction justification. Required: a blank reason fails closed client-side. */
  reason: string;
}

/**
 * The 200 body from POST /v1/customers/{customerRef}/relationship/revert. Undoing
 * a mistaken company-attested end (art. 11 / art. 28) returns the relationship to
 * active; the still-active consents (never withdrawn) apply again. NEVER a DID or
 * a consent_ref.
 */
export interface RelationshipReverted {
  customerRef: string;
  /** The lifecycle after the undo; the relationship is active again. */
  status: "active";
  /** True: this call undid the end as an art. 11 / art. 28 correction. */
  reverted: boolean;
}

/** A declared active catalog entry, for issuance discovery. */
export interface CatalogEntry {
  id: string;
  category: string;
  purpose: string;
  description: string | null;
  /**
   * The ground the company DECLARES for using or communicating this cell. The
   * value set depends on the tenant's regime (a private P-39.1 tenant and a public
   * A-2.1 body use disjoint vocabularies), so it is typed as a string: read the
   * regime before switching on it. It is NOT the basis on which collection is
   * lawful, and Agreely records the declaration without certifying it.
   */
  legalBasis: string;
  /** The company's own declaration that this cell holds sensitive personal information. */
  sensitive: boolean;
}

/** The act governing a tenant, named because `legalBasis` carries two disjoint value sets. */
export interface Regime {
  sector: "private" | "public";
  statute: "P-39.1" | "A-2.1";
}

/**
 * One catalogue cell as a host system reads it (GET /v1/catalog/cells, scope
 * 'retention'): archived cells included, with the rule that governs each one.
 */
export interface CatalogCell extends CatalogEntry {
  categoryEn: string | null;
  purposeEn: string | null;
  status: "active" | "archived";
  /**
   * The retention rule that governs this cell. NULL is the register's own gap,
   * surfaced and never filled: the host ABSTAINS from purging under it and never
   * picks a duration of its own.
   */
  retentionRuleKey: string | null;
}

/** The body of GET /v1/catalog/cells. */
export interface CatalogCells {
  regime: Regime;
  cells: CatalogCell[];
}

// ---------------------------------------------------------------------------
// Host retention (scope 'retention'). « Agreely décide et surveille, l'hôte
// exécute et rend compte »: the host reads decisions it may never invent, and
// DECLARES the purges and passes it ran. Agreely records the declaration; it
// observes nothing in the host's systems and verifies none of it.
// ---------------------------------------------------------------------------

/** What starts a rule's clock. */
export type RetentionTrigger = "collection" | "purpose_achieved" | "last_activity" | "decision";

/**
 * The action a RULE sets. Not to be confused with {@link PurgeMethod}, the
 * disposition a host DECLARES it applied: the rule says `destroy`, the purge says
 * `destroyed`.
 */
export type RetentionAction = "destroy" | "anonymize";

/** One rule the organisation decided. Its duration is never null. */
export interface RetentionRule {
  key: string;
  /** The category of records the rule covers, in the organisation's own words. */
  label: string;
  /** Its English name, null when not authored (never a machine translation). */
  labelEn: string | null;
  duration: { value: number; unit: "months" };
  trigger: RetentionTrigger;
  action: RetentionAction;
  anonymizationProcessKey: string | null;
  /** Archived rules are included: a host may still hold data a retired rule governs. */
  status: "active" | "archived";
  archivedAt: string | null;
  updatedAt: string;
}

/** The body of GET /v1/retention/rules. */
export interface RetentionRuleList {
  /**
   * The next `changedSince`. It deliberately trails the read by a few minutes, so
   * a rule may be sent twice; it is never missed.
   */
  cursor: string;
  /** Every rule, or only those changed since `changedSince`. */
  rules: RetentionRule[];
  /**
   * The COMPLETE current key set, even on an incremental read: a rule deleted in
   * Agreely shows up as a key that disappeared from here.
   */
  ruleKeys: string[];
}

export interface ListRetentionRulesInput {
  /** The `cursor` of a previous response. Refused when malformed or in the future. */
  changedSince?: string;
}

/**
 * One rule, plus the instants of the host's last reports under it: what the host
 * SAID, beside when Agreely received it. Nothing here is an overdue flag or a
 * next due date; the declarative register computes neither.
 */
export interface RetentionRuleDetail extends RetentionRule {
  lastReports: {
    purge: { ranAt: string; declaredAt: string } | null;
    sweep: { sweptAt: string; declaredAt: string } | null;
  };
}

/**
 * The disposition a host DECLARES it applied: the two the acts know. There is no
 * `aggregated`: aggregation is a technique, not a third disposition, and a third
 * value does not compile.
 */
export type PurgeMethod = "destroyed" | "anonymized";

/**
 * An instant: an RFC 3339 string WITH an explicit offset (a naive timestamp is
 * refused, never guessed), or a Date, which the SDK sends in UTC.
 */
export type Instant = string | Date;

/**
 * A host token (`hostSystem`, `hostCategory`): a slug, `^[a-z0-9][a-z0-9._-]{0,63}$`,
 * naming a SYSTEM or a KIND of records, never a record. No run of 5 digits and no
 * hexadecimal identifier.
 *
 * NEW VALUES ARE RATIONED. At most 10 distinct `hostSystem` values per
 * organisation, and 20 distinct `hostCategory` values per rule, may be introduced
 * in any rolling 30 days; past that a NEW value is a 422 `host_token_limit` (a
 * value already reported is always accepted). So a pod name, a container id, a
 * hostname or a deployment slot as `hostSystem` BURNS A SLOT PER DEPLOY and locks
 * you out within days. Use a stable name you choose once: `billing`, `crm`,
 * `warehouse`, never `billing-7f9c8d6b5-x2x4k`.
 */
export type HostToken = string;

interface PurgeDeclarationFields {
  /** When the host says the purge ran. Not in the future, not older than 60 months. */
  ranAt: Instant;
  /**
   * How many records the purge covered: a whole number from 1 to 1,000,000,000.
   * A pass that found NOTHING to purge is a sweep ({@link Retention.declareSweep}),
   * never a purge of zero records.
   */
  recordsAffected: number;
  /** The first day the purge covered, YYYY-MM-DD. */
  coveredFrom: string;
  /** The last day the purge covered, YYYY-MM-DD. Not after the day the purge ran. */
  coveredUntil: string;
  hostSystem: HostToken;
  hostCategory: HostToken;
  /**
   * Optional: the host's own identifiers of the records the purge covered, one per
   * record, at most 1000 and never more than `recordsAffected`. Never stored as
   * text (a keyed lookup, an encrypted salt and a salted commitment each); a
   * refusal names the position (`references[3]`), never the value. A larger purge
   * is declared in several declarations.
   */
  references?: string[];
  /**
   * NOT HERE. The Idempotency-Key is a HEADER, passed as the third argument of
   * declarePurge. Typed `never` so putting it in the body does not compile.
   */
  idempotencyKey?: never;
}

/**
 * A purge declaration. `method` discriminates: `anonymized` REQUIRES the
 * anonymization process that was applied (never defaulted from the rule), and
 * `destroyed` refuses one. Both constraints are compile-time.
 */
export type DeclarePurgeInput =
  | (PurgeDeclarationFields & { method: "destroyed"; anonymizationProcessKey?: never })
  | (PurgeDeclarationFields & { method: "anonymized"; anonymizationProcessKey: string });

/** A pass under a rule that found nothing to purge: the heartbeat. */
export interface DeclareSweepInput {
  /** When the pass ran. Within the last 24 hours, and not in the future. */
  sweptAt: Instant;
  hostSystem: HostToken;
  /** NOT HERE: the Idempotency-Key is the third argument of declareSweep. */
  idempotencyKey?: never;
}

/**
 * The replay key of a declaration, sent as the `Idempotency-Key` HEADER. Required.
 *
 * Derive it from something DURABLE and unique to the operation (your job-run id
 * plus the rule key, say), never from a random value generated per attempt: a key
 * regenerated after a crash is a second declaration, not a retry. 1 to 255
 * printable ASCII characters, refused (never truncated) beyond.
 *
 * THE REPLAY IS BOUND TO THE API KEY THAT DECLARED. Another API key of the same
 * company sending the same Idempotency-Key records its OWN declaration and never
 * reads the first one back. So if you ROTATE your API key while a declaration's
 * response was lost, retrying it with the NEW key records a SECOND declaration.
 * Settle every pending declaration with the old key before you revoke it.
 */
export interface DeclarationOptions {
  idempotencyKey: string;
}

/** A divergence Agreely flags without refusing: never « non-compliant ». */
export interface PurgeWarning {
  code: "method_differs_from_rule";
  message: string;
  ruleAction: string;
  declaredMethod: string;
}

/** The stored purge declaration, echoed to the declaring key only. */
export interface PurgeDeclaration {
  id: string;
  ruleKey: string;
  recorded: true;
  /** Agreely recorded a declaration. Never "verified". */
  status: "declared";
  /** True when this was an idempotent replay (HTTP 200) carrying the STORED values. */
  replayed: boolean;
  ranAt: string;
  recordsAffected: number;
  method: PurgeMethod;
  anonymizationProcessKey: string | null;
  coveredFrom: string;
  coveredUntil: string;
  hostSystem: string;
  hostCategory: string;
  declaredBy: string;
  declaredAt: string;
  /** How many references were recorded (0 when none were sent). */
  referencesRecorded: number;
  /** A method that differs from the rule's action is recorded as declared and flagged here. */
  warnings: PurgeWarning[];
}

/** The stored pass. */
export interface RetentionSweep {
  id: string;
  ruleKey: string;
  recorded: true;
  status: "declared";
  /** What the host SAID, never a fact Agreely established. */
  declaredNothingDue: true;
  replayed: boolean;
  sweptAt: string;
  hostSystem: string;
  declaredBy: string;
  declaredAt: string;
}

/**
 * The rules a host persists between runs, so a purge job can reason about an
 * outage. Opaque in intent: store it whole (JSON-serialisable) and hand it back.
 */
export interface RetentionRuleSnapshot {
  /** The server cursor, the next `changedSince`. */
  cursor: string;
  /** When THIS process last read the rules from Agreely (ISO-8601, local clock). */
  fetchedAt: string;
  /** The complete current rule set, keyed by nothing: one entry per rule. */
  rules: RetentionRule[];
}

/**
 * What a purge job may do with the rules for this run. Narrow on `source` before
 * reading `rules`: the abstain branch carries none, so a job cannot purge on it
 * without a compile error.
 *
 *   "live"     -> read from Agreely now. Persist `snapshot` for the next run.
 *   "snapshot" -> Agreely was unreachable and you OPTED IN to purging on the stored
 *                 rules (onOutage: "use-snapshot"). `staleForMs` says how old they
 *                 are. See the asymmetry on {@link RulesForPurgeOptions.onOutage}.
 *   "abstain"  -> Agreely was unreachable and no usable snapshot applies. Do NOT
 *                 purge this run. This is the default outcome of an outage.
 */
export type RulesForPurge =
  | { source: "live"; rules: RetentionRule[]; snapshot: RetentionRuleSnapshot }
  | { source: "snapshot"; rules: RetentionRule[]; snapshot: RetentionRuleSnapshot; staleForMs: number; error: Error }
  | { source: "abstain"; reason: "outage" | "no_snapshot" | "snapshot_too_old"; error: Error };

/** The evidence record emitted when a purge run proceeds on stored rules. */
export interface RetentionDegradeContext {
  /** When the stored rules were last read from Agreely. */
  snapshotFetchedAt: string;
  staleForMs: number;
  /** The underlying outage error (503 / network / timeout). */
  error: Error;
  /** ISO-8601 timestamp of the decision. */
  at: string;
}

interface RulesForPurgeBase {
  /**
   * The snapshot a previous run persisted. When given and Agreely answers, only
   * the rules changed since its cursor are read and merged in (a rule whose key
   * left `ruleKeys` is dropped).
   */
  snapshot?: RetentionRuleSnapshot | null;
}

/**
 * Options for {@link Retention.rulesForPurge}. `onOutage` defaults to "abstain".
 *
 * WHY THE DEFAULT IS TO NOT PURGE. The two ways stored rules can be wrong are not
 * symmetrical:
 *   - a rule was SHORTENED and you missed it: you keep data somewhat too long.
 *     That is a minor lapse, corrected on the next run that reads the rules.
 *   - a rule was LENGTHENED (a legal hold, an investigation, a litigation) and you
 *     missed it: you DESTROY what you were required to keep, and that never
 *     repairs.
 * So on an outage the job abstains, the opposite of a consent check (where
 * failing closed means denying). "use-snapshot" accepts the second risk,
 * explicitly, bounded by `maxSnapshotAge` and audited through `onDegrade`.
 */
export type RulesForPurgeOptions =
  | (RulesForPurgeBase & { onOutage?: "abstain" })
  | (RulesForPurgeBase & {
      onOutage: "use-snapshot";
      /**
       * The oldest snapshot you accept, e.g. "26h". Capped by the client's
       * `maxDegradeWindow` (default 24h): raise that option to accept a
       * snapshot from the previous nightly run.
       */
      maxSnapshotAge: string;
      /** Evidence sink, called once per run that proceeds on stored rules. Mandatory. */
      onDegrade: (ctx: RetentionDegradeContext) => void;
    });

// ---------------------------------------------------------------------------
// Host inventory (scope 'inventory'). A host system declares the record sets it
// holds and the NAMES of their fields, never a value; Agreely links each set to
// a catalogue cell and hands back the retention statement the host stamps on a
// record at collection. What a set says it holds is what the host DECLARED.
// ---------------------------------------------------------------------------

/**
 * One field of a record set: its NAME, never a value. A label shaped like a value
 * (an at sign, a run of five digits, a calendar date) is refused, as is any member
 * other than these three.
 */
export interface InventoryFieldInput {
  key: HostToken;
  /** 1 to 120 characters, not starting with = + - or @. */
  label: string;
  labelEn?: string | null;
}

/** One record set a host system holds. */
export interface InventoryCategoryInput {
  key: HostToken;
  label: string;
  labelEn?: string | null;
  /** 1 to 60 fields. */
  fields: InventoryFieldInput[];
}

/**
 * A host system's COMPLETE inventory. Every set this system declared before and
 * that is not in `categories` is WITHDRAWN. 1 to 50 sets.
 */
export interface ReplaceInventoryInput {
  hostSystem: HostToken;
  categories: InventoryCategoryInput[];
}

/**
 * A frozen retention statement: the terms in force when it was frozen. A record
 * collected under « 3 mois » keeps a key that resolves to « 3 mois » after the
 * rule becomes 2.
 */
export interface RetentionStatement {
  key: string;
  revision: number;
  frozenAt: string;
  /** False on a gap row: then duration, trigger, action and text are null. */
  decided: boolean;
  duration: { value: number; unit: "months" } | null;
  trigger: RetentionTrigger | null;
  action: RetentionAction | null;
  /** The plain-language sentence, in both locales, or null when not decided. */
  text: { fr: string; en: string } | null;
}

/** One declared record set, and what Agreely decided for it. */
export interface InventoryRecordSet {
  key: string;
  hostSystem: string;
  label: string;
  labelEn: string | null;
  fields: Array<{ key: string; label: string; labelEn: string | null }>;
  status: "declared" | "withdrawn";
  firstDeclaredAt: string | null;
  lastDeclaredAt: string | null;
  withdrawnAt: string | null;
  /**
   * `decided` when the set is linked to a cell that has a rule; otherwise the gap,
   * named (`no_cell`, `no_rule`), and the host ABSTAINS: it never invents a number.
   */
  decision: {
    state: "decided" | "no_cell" | "no_rule";
    cellKey: string | null;
    ruleKey: string | null;
  };
  retentionStatement: RetentionStatement | null;
}

/** The body of PUT /v1/inventory/categories. */
export interface InventoryDeclaration {
  hostSystem: string;
  /** How many of this system's sets the declaration withdrew (they stay listed, marked withdrawn). */
  withdrawn: number;
  categories: InventoryRecordSet[];
}

export interface ListInventoryInput {
  /** Narrow to one host system. */
  hostSystem?: HostToken;
}

/** One frozen statement, resolved by the key a host stamped on a record. */
export interface ResolvedRetentionStatement extends RetentionStatement {
  categoryKey: string;
  hostSystem: string;
  /** False once a later statement superseded it; it still resolves, that is the point of freezing. */
  current: boolean;
  supersededAt: string | null;
}

// ---------------------------------------------------------------------------
// Degrade policy types (the fail-closed default + three-gate exception).
// ---------------------------------------------------------------------------

/** How a degraded allow was authorized. */
export type DegradeMode = "fail-open" | "break-glass";

/** The evidence record emitted for every degraded ALLOW. */
export interface DegradeContext {
  customerId: string;
  category: string;
  purpose: string;
  mode: DegradeMode;
  /** The operator reason, present for a break-glass allow. */
  reason?: string;
  /** True when this allow was authorized by an engaged break-glass. */
  breakGlass: boolean;
  /** The underlying outage error (503 / network / timeout). */
  error: Error;
  /** ISO-8601 timestamp of the degraded allow. */
  at: string;
}

/**
 * Integrator config to opt specific categories into fail-open on an outage.
 * Off by default (the SDK is fail-closed). `onDegrade` is MANDATORY when
 * `mode: "fail-open"` — absent, the constructor throws.
 */
export interface DegradeOnOutageConfig {
  /** The explicit word. Only "fail-open" enables the exception. */
  mode: "fail-open";
  /** ONLY these (operator-declared) categories may ever degrade. */
  categories: string[];
  /** Refuse to keep degrading past this window, e.g. "5m", "30s", "1h". */
  maxOutageWindow: string;
  /** Evidence sink. Called for every degraded allow. Mandatory here. */
  onDegrade: (ctx: DegradeContext) => void;
}

/**
 * An auditable break-glass event.
 *
 *   "engage" / "disengage" / "expire" — lifecycle of the operator lever.
 *   "authorized" — a PER-DECISION record: a single break-glass-authorized allow
 *     that happened during an outage. Emitted for EVERY such allow, regardless of
 *     whether `degradeOnOutage` is configured, so the evidence trail can show
 *     every access allowed inside a break-glass window (not just engage/expire).
 *     Carries the customer/category/purpose/error of the specific decision.
 */
export interface BreakGlassEvent {
  action: "engage" | "disengage" | "expire" | "authorized";
  reason?: string;
  scope?: string[];
  ttl?: string;
  at: string;
  expiresAt?: string;
  /** Present on "authorized": the customer of the allowed decision. */
  customerId?: string;
  /** Present on "authorized": the (raw) category of the allowed decision. */
  category?: string;
  /** Present on "authorized": the (raw) purpose of the allowed decision. */
  purpose?: string;
  /** Present on "authorized": the underlying outage error (503 / network / timeout). */
  error?: Error;
}

export interface BreakGlassEngageInput {
  /** Mandatory. Engaging without a reason throws. */
  reason: string;
  /** Auto-expiry, e.g. "30m". */
  ttl: string;
  /** Categories this break-glass covers. Omit to cover all. */
  scope?: string[];
}

export interface AgreelyOptions {
  /** The Agreely API key (agr_live_...). Required. */
  apiKey: string;
  /** API base URL. Defaults to https://api.agreely.ca. */
  baseUrl?: string;
  /**
   * Per-call TOTAL time budget in ms (connect + transfer + any transient-outage
   * retry). Default 800.
   *
   * 800ms is sized for a call inside the SAME datacentre or region as the API. It is
   * NOT a safe budget over the open internet: a cold TLS handshake plus a cross-region
   * round trip can exceed it on a perfectly healthy server.
   *
   * This matters because the SDK FAILS CLOSED: a timeout is treated as an outage, so
   * `check` returns false and `checkDetailed` throws AgreelyUnavailableError. An
   * under-set timeout therefore does not produce a slow answer, it produces a SPURIOUS
   * DENY, and the person is shown less of their own data than they consented to. If
   * you call api.agreely.ca from outside its region, RAISE IT. A well-tested
   * internet-facing pairing is `{ timeout: 8000, maxRetries: 1 }`.
   *
   * The default is deliberately left low rather than raised for everyone: this is a
   * synchronous gate on a request path, and an unattended multi-second default would
   * turn an Agreely outage into a multi-second hang on every one of your pages. Choose
   * the budget your deployment can actually pay.
   */
  timeout?: number;
  /** Opt specific categories into fail-open on an outage. Off by default. */
  degradeOnOutage?: DegradeOnOutageConfig;
  /** Audit sink for break-glass engage/disengage/expire AND per-decision authorized allows. */
  onBreakGlass?: (event: BreakGlassEvent) => void;
  /**
   * Upper bound for both a break-glass `ttl` and `degradeOnOutage.maxOutageWindow`.
   * A value like "30m" or "24h". Exceeding it throws AgreelyConfigError (an
   * unbounded fail-open window is a compliance risk). Defaults to "24h".
   */
  maxDegradeWindow?: string;
  /**
   * Inject a fetch implementation (tests / custom transport). Defaults to the
   * global fetch (Node 18+), falling back to a lazily-imported `undici`.
   */
  fetch?: typeof fetch;
  /**
   * Opt-in: how many EXTRA attempts to make on a 429 for IDEMPOTENT calls
   * (GET / check). Default 0 (surface AgreelyRateLimitError immediately, as
   * before). A mutating call is never auto-retried on a 429.
   */
  maxRetries?: number;
  /**
   * When retrying a 429 (see {@link maxRetries}), wait the server's Retry-After
   * header before the next attempt. Default true.
   */
  respectRetryAfter?: boolean;
}

/** Per-call options for check / checkDetailed. */
export interface CheckOptions {
  /**
   * Per-call outage override. "allow" requests a fail-open for THIS call, and
   * is effective ONLY if the category is also in the config allow-list (two
   * gates). "deny" forces fail-closed. Default: the configured behavior.
   */
  onOutage?: "allow" | "deny";
}
