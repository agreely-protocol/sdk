// The result surface of the offline receipt verifier. HONESTY IS THE POINT: each
// field reports exactly what was PROVED vs merely TRUSTED, and `overall` never
// overstates it (a citizen receipt is at most "partial" offline).

/**
 * The outcome of a single verification check.
 *
 *   - pass         the cryptography verified.
 *   - fail         the cryptography actively did NOT verify (a tamper / wrong key).
 *   - unavailable  the check could NOT be completed — the issuer/citizen DID could
 *                  not be resolved (network outage, unreachable host, key not
 *                  found). DISTINCT from "fail": a valid receipt during a DID
 *                  outage must never look byte-identical to a forgery.
 *   - skipped      the input needed for this check was absent (or not requested).
 *   - unsupported  the check is not applicable to this receipt type.
 */
export type CheckStatus = "pass" | "fail" | "unavailable" | "skipped" | "unsupported";

/**
 * The aggregate verdict.
 *
 *   - verified     a company-attested receipt, fully sound.
 *   - partial      a citizen receipt offline, or a verbal (company_documented)
 *                  receipt whose company signature verified: honest, not a failure.
 *   - failed       a decisive check ACTIVELY failed (a tamper / wrong key).
 *   - unavailable  a decisive check could NOT be completed (the DID could not be
 *                  resolved). Verification is inconclusive, NOT a forgery.
 */
export type OverallStatus = "verified" | "partial" | "failed" | "unavailable";

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
 *   - companySignature  pass/fail for a company-attested receipt; "unavailable"
 *                       when the issuer DID could not be resolved (outage, not a
 *                       tamper); "unsupported" OFFLINE for a citizen receipt (the
 *                       company signed the original offer, which the receipt omits
 *                       for unlinkability).
 *   - citizenAssertion  pass/fail of the citizen WebAuthn passkey assertion for a
 *                       citizen receipt; "unavailable" when the citizen DID/passkey
 *                       could not be resolved; "unsupported" for a company-attested
 *                       one (there is no citizen signature).
 *   - disclosureCopy    pass/fail when the receipt carries a document.ipfsCid +
 *                       disclosureHash; "skipped" otherwise.
 *   - documentAnchor    pass/fail of the opt-in on-chain check; "skipped" without
 *                       an rpcUrl (or a CID to look up).
 *   - cellLabelBinding  whether the human-readable cell labels (category/purpose)
 *                       are CRYPTOGRAPHICALLY bound in THIS offline verification —
 *                       the one field to read before trusting a displayed label.
 *                       company_attested: tracks companySignature (the labels sit
 *                       inside the signed body, so a mutation breaks it). citizen:
 *                       "unsupported" OFFLINE (the receipt omits the salted
 *                       commitment + Merkle root that bind the labels for
 *                       unlinkability). No server endpoint re-checks it: the
 *                       labels are covered only by the company signature over
 *                       the OFFER, which travels in the verification bundle.
 */
export interface ReceiptVerification {
  receiptType: ReceiptType;
  companySignature: CheckStatus;
  citizenAssertion: CheckStatus;
  disclosureCopy: CheckStatus;
  documentAnchor: CheckStatus;
  cellLabelBinding: CheckStatus;
  overall: OverallStatus;
  /** Plain-language notes stating what each result proves vs trusts. */
  notes: string[];
}

/** A resolved W3C DID document (only the fields the verifier reads are typed). */
export interface DidDocument {
  id?: string;
  verificationMethod?: DidVerificationMethod[];
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
   * SECURITY: the default did:web resolver fetches a host TAKEN FROM THE RECEIPT.
   * It can never yield a false "verified" (the key must still verify the
   * signature), but when verifying UNTRUSTED receipts you SHOULD inject your own
   * `resolver` (or supply DID documents locally) to control the request surface
   * (SSRF) rather than letting an attacker-chosen host be fetched.
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
   * Whether to fetch + compare the IPFS disclosure copy when the receipt carries
   * a document.ipfsCid. Default true. Set false to keep verification network-free
   * for disclosure (it is then reported "skipped").
   */
  verifyDisclosure?: boolean;
  /** Map an IPFS CID to a gateway URL. Default: the Lighthouse gateway. */
  ipfsGateway?: (cid: string) => string;
  /** JSON-RPC URL for the opt-in on-chain documentAnchor check. Omit to skip it. */
  rpcUrl?: string;
  /** AgreelyRegistry address. Defaults per chainId (Base mainnet 8453). */
  registryAddress?: string;
  /** Chain id for the anchor check. Default 8453 (Base mainnet); pass 84532 to test on Base Sepolia. */
  chainId?: number;
  /** Injectable fetch (tests / custom transport). Defaults to global fetch. */
  fetch?: typeof fetch;
}
