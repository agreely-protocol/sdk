// The result surface of the receipt verifier. HONESTY IS THE POINT: each field
// reports exactly what was PROVED vs merely TRUSTED, and `overall` never
// overstates it (a bare passkey receipt is at most "incomplete").

/**
 * The outcome of a single verification check.
 *
 *   - pass         the cryptography verified.
 *   - fail         the cryptography actively did NOT verify, or the chain answered
 *                  and contradicts the receipt (a tamper / wrong key).
 *   - unavailable  the check could NOT be completed: a DID could not be resolved,
 *                  a gateway or an RPC failed, refused or timed out. DISTINCT from
 *                  "fail": a valid receipt during an outage must never look
 *                  byte-identical to a forgery.
 *   - unbound      the signature verifies, but nothing ties it to this receipt's
 *                  content (a bare passkey receipt's assertion). Proves nothing
 *                  about the receipt.
 *   - skipped      the input needed for this check was absent (or not requested).
 *   - unsupported  the check is not applicable to this input.
 *   - withdrawn    the consent is authentic and under the receipt's root, but the chain records
 *                  its withdrawal (state 2) at `revokedAt`. Neither a pass nor a forgery.
 */
export type CheckStatus = "pass" | "fail" | "unavailable" | "unbound" | "skipped" | "unsupported" | "withdrawn";

/**
 * The aggregate verdict.
 *
 *   - verified     a company-attested receipt, or a passkey receipt verified from
 *                  its bundle: every decisive check passed.
 *   - partial      a verbal (company_documented) receipt whose company signature
 *                  verified: the organisation's word, authenticated.
 *   - incomplete   a bare passkey receipt: it cannot be verified on its own. Verify
 *                  the bundle issued with it. Never a pass, never a tamper.
 *   - failed       a check ACTIVELY failed (a tamper / wrong key / contradiction).
 *   - unavailable  a decisive check could NOT be completed (the DID could not be
 *                  resolved). Verification is inconclusive, NOT a forgery.
 *   - withdrawn    the receipt is authentic and its consent was withdrawn on chain. Given only when every other
 *                  decisive check would have produced `verified`: a `fail` elsewhere still gives `failed`, an
 *                  `unavailable` elsewhere still gives `unavailable`, and the consentAnchor check reads `withdrawn`.
 *   - malformed    the input is not a receipt or bundle this verifier can read: not
 *                  an object, a bundle of another version, a bundle whose receipt or
 *                  signed offer is missing or not an object, a value the
 *                  canonicalizer refuses, or nesting past 64 levels. No check ran,
 *                  so it says nothing about alteration. Never a pass.
 */
export type OverallStatus = "verified" | "partial" | "incomplete" | "failed" | "unavailable" | "malformed" | "withdrawn";

/**
 * Which kind of receipt was verified.
 *
 *   - company_attested    a hand-signed paper consent the company attested to.
 *   - company_documented  a consent given BY TELEPHONE and documented by the
 *                         organisation (a VerbalConsentReceipt). No document, no
 *                         citizen signature: at most "partial" overall, never
 *                         "verified", because the organisation's word is all there is.
 *   - citizen             a passkey-signed consent.
 */
export type ReceiptType = "company_attested" | "company_documented" | "citizen";

/**
 * The full, honest verification report.
 *
 *   - input             "bundle" when the input was a verification bundle (detected,
 *                       never misread as a receipt), "receipt" for a bare receipt.
 *   - companySignature  recorded receipt: the Ed25519 signature over the body. Passkey
 *                       bundle: proof[0] over the signed offer. "unsupported" on a
 *                       bare passkey receipt (the offer travels only in the bundle).
 *   - receiptIntegrity  passkey bundle: the receipt matches the signed offer field by
 *                       field, the disclosureHash recomputes from the offer, validFrom
 *                       equals grantedAt, and, once the company signature holds,
 *                       grantedAt lies between the offer's createdAt and expiresAt
 *                       (whole seconds). Recorded receipt: the same value as
 *                       companySignature (the signature covers the body). "unsupported"
 *                       on a bare passkey receipt.
 *   - citizenAssertion  passkey bundle: the WebAuthn assertion verifies, its
 *                       challenge recomputes from this receipt and the bundle, AND the
 *                       citizen's DID document (id = the subject) lists that exact key
 *                       under `authentication` with a window [validFrom, validUntil)
 *                       covering grantedAt. A document that lists it otherwise is
 *                       "fail"; one that cannot be read as the subject's is
 *                       "unavailable".
 *                       "unbound" on a bare passkey receipt whose assertion verifies:
 *                       nothing ties it to the content. "unsupported" on a recorded one.
 *   - disclosureCopy    OPT-IN (verifyDisclosure): the IPFS copy against the SIGNED
 *                       disclosureHash (and v2 legalBasis). "unsupported" on a bare
 *                       passkey receipt, whose hash is signed by nobody.
 *   - documentAnchor    OPT-IN (rpcUrl): the document CID's on-chain anchor, read with
 *                       rootOf(keccak256(cid)). "pass" only in the consent-document lane;
 *                       "unavailable" when no record yet: the document is published first and anchored
 *                       asynchronously, so an absent record is not a contradiction. "fail" when another
 *                       lane holds the CID or the record is tagged. "unavailable" also when no registry is
 *                       known for the chain, or the bundle names another registry (nothing is read).
 *   - consentAnchor     OPT-IN (rpcUrl), bundle only: the consent's on-chain record,
 *                       read with registry(consentRef) and tied by the bound Merkle root.
 *                       "pass" only when every cell's record was read and is in force; a
 *                       withdrawn cell (state 2, under the bundle's root) is "withdrawn", with
 *                       its `revokedAt` in consentAnchorRecords. A record under another root is "fail".
 *   - cellLabelBinding  whether the human-readable cell labels (category/purpose) are
 *                       CRYPTOGRAPHICALLY bound, the one field to read before trusting
 *                       a displayed label.
 */
export interface ReceiptVerification {
  input: "bundle" | "receipt";
  receiptType: ReceiptType;
  companySignature: CheckStatus;
  receiptIntegrity: CheckStatus;
  citizenAssertion: CheckStatus;
  disclosureCopy: CheckStatus;
  documentAnchor: CheckStatus;
  consentAnchor: CheckStatus;
  cellLabelBinding: CheckStatus;
  overall: OverallStatus;
  /** Present when documentAnchor passed: when, and in which block, the document CID was anchored. */
  documentAnchorRecord?: DocumentAnchorRecord;
  /** Present when consentAnchor read a cell under the bundle's Merkle root: one record per such cell. */
  consentAnchorRecords?: ConsentAnchorRecord[];
  /** Plain-language notes stating what each result proves vs trusts. */
  notes: string[];
}

/** A document CID's on-chain anchor (rootOf, lane 3). Times are unix seconds. */
export interface DocumentAnchorRecord {
  anchoredAt: number;
  anchoredBlock: number;
}

/** One consent cell's on-chain record (registry(consentRef)). Times are unix seconds; revokedAt is 0 while in force. */
export interface ConsentAnchorRecord {
  consentRef: string;
  state: "active" | "withdrawn";
  anchoredAt: number;
  revokedAt: number;
  anchoredBlock: number;
}

/** A resolved W3C DID document (only the fields the verifier reads are typed). */
export interface DidDocument {
  id?: string;
  verificationMethod?: DidVerificationMethod[];
  /** Method references (`#passkey-1` or the full id) a citizen key must appear under. */
  authentication?: unknown[];
  [key: string]: unknown;
}

export interface DidVerificationMethod {
  id?: string;
  type?: string;
  controller?: string;
  /** Ed25519 (company) key, z-base58btc multibase. */
  publicKeyMultibase?: string;
  /** WebAuthn (citizen) COSE key, 0x-hex. */
  publicKeyCose?: string;
  /** Citizen key: the instant it starts to belong to the person (RFC 3339 or a date). */
  validFrom?: string;
  /** Citizen key: the instant it stops, exclusive; null while it is current. */
  validUntil?: string | null;
  [key: string]: unknown;
}

/** Resolves a DID (company did:web or citizen did:agreely) to its DID document. */
export type DidResolver = (did: string) => Promise<DidDocument | null> | DidDocument | null;

/** Options for {@link ReceiptVerifier}/verifyReceipt. All network seams injectable. */
export interface VerifyReceiptOptions {
  /**
   * Resolve a DID to its DID document. Default: HTTPS did:web resolution
   * (`did:web:host:c:slug` -> `https://host/c/slug/did.json`) and citizen
   * `did:agreely:*` resolution via `${citizenResolverBaseUrl}/did/{did}`. HTTPS is
   * enforced (no http/file).
   *
   * SECURITY: the default did:web resolver fetches whatever host the receipt
   * names. A "verified" therefore says the receipt was signed by whoever controls
   * that host's DID document, not that the host is the organisation you expect: a
   * receipt under `did:web:any-host` signed by that host's own key verifies. When
   * verifying UNTRUSTED receipts, inject your own `resolver` (or supply DID
   * documents locally) to pin the issuers you trust and control the request
   * surface (SSRF). The keys are never taken from a bundle's own didDocuments.
   *
   * The citizen half is checked only for a `did:agreely:citizen:` subject, whatever
   * the resolver: any other subject (a `did:web` the forger hosts) makes the
   * assertion "unavailable", so such a bundle is never "verified".
   */
  resolver?: DidResolver;
  /**
   * Host used to build a company did:web from a slug in `resolveCompanyDid`. Default
   * `app.agreely.ca`, the Agreely WEB (dashboard) tier, which is what serves
   * `/c/{slug}/did.json`. Not the apex `agreely.ca`, which is the marketing site and
   * 404s on that path.
   */
  companyDidHost?: string;
  /**
   * Base URL for the default citizen DID resolver's `/did/{did}`. Default
   * `https://my.agreely.ca`, the Agreely CITIZEN tier, which is what serves that
   * route. Not the api tier, which 404s on it.
   */
  citizenResolverBaseUrl?: string;
  /**
   * OPT-IN: fetch the IPFS disclosure copy from a third-party gateway and compare
   * it with the signed disclosureHash. Default false (reported "skipped"): the
   * call is a privacy and availability cost the caller chooses.
   */
  verifyDisclosure?: boolean;
  /** Map an IPFS CID to a gateway URL. Default: the Lighthouse gateway. */
  ipfsGateway?: (cid: string) => string;
  /** JSON-RPC URL for the opt-in on-chain checks (documentAnchor, consentAnchor). Omit to skip them. */
  rpcUrl?: string;
  /**
   * AgreelyRegistry address, read by eth_call (`rootOf`, `registry`) whatever it is. Default: the known registry
   * of chainId (Base mainnet and Base Sepolia are known). On any other chain, pass it, or the anchor checks read
   * `unavailable`.
   */
  registryAddress?: string;
  /** Chain id for the anchor checks. Default 8453 (Base mainnet); pass 84532 to test on Base Sepolia. */
  chainId?: number;
  /** Timeout of each RPC, IPFS and DID call, in milliseconds. Default 10000. */
  timeoutMs?: number;
  /**
   * Deadline for the whole on-chain sequence of one verification, in milliseconds, from
   * its first RPC call. Past it, no further RPC call is made and the anchor checks still
   * pending read "unavailable". Default 30000.
   */
  rpcDeadlineMs?: number;
  /** Injectable fetch (tests / custom transport). Defaults to global fetch. */
  fetch?: typeof fetch;
}
