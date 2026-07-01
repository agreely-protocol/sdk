// The result surface of the offline receipt verifier. HONESTY IS THE POINT: each
// field reports exactly what was PROVED vs merely TRUSTED, and `overall` never
// overstates it (a citizen receipt is at most "partial" offline).

/** The outcome of a single verification check. */
export type CheckStatus = "pass" | "fail" | "skipped" | "unsupported";

/** The aggregate verdict. A citizen receipt is at most "partial" offline. */
export type OverallStatus = "verified" | "partial" | "failed";

/** Which kind of receipt was verified. */
export type ReceiptType = "company_attested" | "citizen";

/**
 * The full, honest verification report.
 *
 *   - companySignature  pass/fail for a company-attested receipt; "unsupported"
 *                       OFFLINE for a citizen receipt (the company signed the
 *                       original offer, which the receipt omits for unlinkability).
 *   - citizenAssertion  pass/fail of the citizen WebAuthn passkey assertion for a
 *                       citizen receipt; "unsupported" for a company-attested one
 *                       (there is no citizen signature).
 *   - disclosureCopy    pass/fail when the receipt carries a document.ipfsCid +
 *                       disclosureHash; "skipped" otherwise.
 *   - documentAnchor    pass/fail of the opt-in on-chain check; "skipped" without
 *                       an rpcUrl (or a CID to look up).
 */
export interface ReceiptVerification {
  receiptType: ReceiptType;
  companySignature: CheckStatus;
  citizenAssertion: CheckStatus;
  disclosureCopy: CheckStatus;
  documentAnchor: CheckStatus;
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
   * `did:agreely:*` resolution via `${citizenResolverBaseUrl}/did/{did}`.
   */
  resolver?: DidResolver;
  /** Host used to build a company did:web from a slug in resolveCompanyDid. Default api.agreely.ca. */
  companyDidHost?: string;
  /** Base URL for the default citizen DID resolver's `/did/{did}`. Default https://api.agreely.ca. */
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
  /** AgreelyRegistry address. Defaults per chainId (Base Sepolia 84532). */
  registryAddress?: string;
  /** Chain id for the anchor check. Default 84532 (Base Sepolia). */
  chainId?: number;
  /** Injectable fetch (tests / custom transport). Defaults to global fetch. */
  fetch?: typeof fetch;
}
