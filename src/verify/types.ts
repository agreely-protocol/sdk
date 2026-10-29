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
 *                  byte-identical to a forgery. With an rpcUrl, an anchor check
 *                  also reads "unavailable" when the bundle names a registry or
 *                  chain other than the one read: that unknown registry is refused
 *                  before any RPC call, and the note says "unknown registry".
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
 *                  resolved). Verification is inconclusive, NOT a forgery. Also given,
 *                  with an rpcUrl, when the bundle names a registry or chain other than
 *                  the one read and an anchor check would read the chain (a receipt
 *                  with a `document.ipfsCid`, or a bundle with a `consentRef`): that
 *                  unknown registry is refused before any RPC call, unless a check
 *                  failed. Such a bundle is never `verified` or `withdrawn`.
 *   - withdrawn    the receipt is authentic and its consent was withdrawn on chain. Given only when every other
 *                  decisive check would have produced `verified`: a `fail` elsewhere still gives `failed`, an
 *                  `unavailable` elsewhere still gives `unavailable`, and the consentAnchor check reads `withdrawn`.
 *   - malformed    the input is not a receipt or bundle this verifier can read: not
 *                  an object, a bundle of another version, a bundle whose receipt or
 *                  signed offer is missing or not an object, a passkey receipt in a
 *                  bundle carrying a field the issuer never writes (at its top level,
 *                  in credentialSubject or in its consent), a value the
 *                  canonicalizer refuses, or nesting past 64 levels. No check ran,
 *                  so it says nothing about alteration. Never a pass.
 *
 * `overall` judges the receipt. Whether the consent is still in force is `withdrawal`: without an
 * `rpcUrl` nothing reads it, so a withdrawn consent verified offline still reads `verified`.
 */
export type OverallStatus = "verified" | "partial" | "incomplete" | "failed" | "unavailable" | "malformed" | "withdrawn";

/**
 * Whether the consent is still in force, as the chain records it. Always present.
 *
 *   - active       every cell was read on chain (`rpcUrl`) under the trusted Merkle root, and none is
 *                  withdrawn: on a passkey bundle, the root its verified assertion binds and every accepted
 *                  cell; on a version 4 paper or telephone receipt in a bundle, the root and refs it signs.
 *   - withdrawn    the chain records the withdrawal of at least one cell under that root: `withdrawnAt`
 *                  gives the latest withdrawal when the record carries its instant.
 *   - not_checked  nothing established it: no `rpcUrl`; a bare passkey receipt, a paper or telephone receipt
 *                  before version 4 (it signs no anchor) or one outside its bundle; a root no verified
 *                  signature binds, or a version 4 receipt whose company key the registry did not confirm at
 *                  the instant it signed; or a read that did not cover every cell (an RPC failure, a cell not
 *                  anchored yet, an unknown anchor count, a refused registry, a contradicting record). The
 *                  consent may have been withdrawn.
 *
 * Says nothing about the receipt's authenticity: read `overall` first.
 */
export type WithdrawalStatus = "active" | "withdrawn" | "not_checked";

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
 *                       Checked only with the method proof[0] names, controlled by the
 *                       issuer and listed under the issuer document's assertionMethod
 *                       (a fragment naming no method: the document's sole
 *                       assertionMethod key). No such key in a resolved document: "fail".
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
 *                       The bundle's ref list is signed by no one, so every accepted cell the receipt
 *                       lists counts: a cell with no ref in the list counts as unreadable.
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
  /** Whether the consent is still in force, as the chain records it ({@link WithdrawalStatus}). */
  withdrawal: WithdrawalStatus;
  /** Present when `withdrawal` is "withdrawn" and the chain records when: the latest withdrawal, unix seconds. */
  withdrawnAt?: number;
  /** Present when documentAnchor passed: when, and in which block, the document CID was anchored. */
  documentAnchorRecord?: DocumentAnchorRecord;
  /** Present when consentAnchor read a cell under the bundle's Merkle root: one record per such cell. */
  consentAnchorRecords?: ConsentAnchorRecord[];
  /** Per-cell tally of the consent anchor read (the `rpcUrl` option), set when that read ran and did not fail. */
  consentAnchorCounts?: {
    cells: number;
    active: number;
    withdrawn: number;
    pending: number;
    unreadable: number;
    /** The refCount of the one AnchorBatch log of the trusted root at the block its refs sit in, when read. */
    anchorBatchRefs?: number;
  };
  /** True when an anchor check refused the bundle's registry before any RPC call (an unknown registry or chain). */
  registryRefused?: boolean;
  /**
   * With an `rpcUrl`, when a company key verified the signature: is that key in force on the company's domain at the
   * instant it signed (`companyKeyOf`)? pass (authentic), fail (not authorised then, signed after the consent anchor,
   * or voided), unavailable (no window yet, recorded late, retired since on the issuer's own date, unreadable or
   * unreachable, or no domain), skipped (no key verified the signature). Absent without an `rpcUrl`.
   */
  companyKeyRegistry?: CheckStatus;
  /** What the registry said about the company key, beside `companyKeyRegistry`. */
  companyKey?: CompanyKeyReading;
  /**
   * With an `rpcUrl`, on a passkey bundle: the person's key on chain (`keyOf`), read with the consent's anchor.
   * pass (the chain confirms the key at grantedAt), fail (a refusal: not in force at grantedAt, or granted after
   * the consent's anchor), unavailable (a caution or nothing to add: see `citizenKey.reason`), skipped (no salt and
   * no keyOf registry read, or no verified assertion). Absent without an `rpcUrl` and on other receipts.
   */
  citizenKeyChain?: CheckStatus;
  /** The person's key reading, beside `citizenKeyChain`. */
  citizenKey?: CitizenKeyReading;
  /**
   * A recorded receipt of version 4 in a bundle, whose signature held: the anchor batch it signs and how the
   * bundle's own (unsigned) root and refs stand against it. Absent otherwise.
   */
  signedAnchor?: SignedAnchorReading;
  /** The gateway that delivered the IPFS document, as configured (or the origin of a function's URL). */
  disclosureGateway?: string;
  /** Plain-language notes stating what each result proves vs trusts. */
  notes: string[];
}

/**
 * The company key's standing at its signing instant: a window verdict (see `companyKeyRegistry`), `unreachable`
 * (the read failed or did not decode) or `no-domain` (the issuer DID document names no domain).
 */
export type CompanyKeyVerdict =
  | "authentic"
  | "key-not-authorised"
  | "signed-after-anchor"
  | "pending"
  | "voided"
  | "recorded-late"
  | "retired-issuer-dated"
  | "unknown"
  | "unreachable"
  | "no-domain";

export interface CompanyKeyReading {
  verdict: CompanyKeyVerdict;
  /** The company domain the issuer DID document names (its first alsoKnownAs), "" when none. */
  domain: string;
  /** keccak256(domain), "" when no domain. */
  domainHash: string;
  /** sha256 of the raw Ed25519 key that verified the signature. */
  keyId: string;
  /** The signing instant, unix seconds: recordedAt for a recorded receipt of version 2 to 4, grantedAt otherwise. */
  signedAt: number | null;
  /** The latest consent anchor that bounds the signing instant (unix seconds), or null: the date is the issuer's own. */
  boundedBy: number | null;
  /** Not authorised because the signing instant falls before the key's validFrom. */
  notYetEffective: boolean;
  /** The window an authentic key was in force over (unix seconds, as decimal strings; retiredAt "0" = open). */
  window?: { validFrom: string; retiredAt: string };
  /** The key the company's DID record names today (getCompanyDid), when it answered. */
  currentKeyId?: string;
  /** An authentic key the company has since rotated away from. */
  rotated?: boolean;
}

export interface CitizenKeyReading {
  /** keyOf's answer at grantedAt (notLinked: no salt in the bundle; notRecorded: still unrecorded 72 h after it). */
  chainState:
    | "notLinked"
    | "unreadable"
    | "unreachable"
    | "pending"
    | "notRecorded"
    | "voided"
    | "notInForce"
    | "recordedLate"
    | "inForce";
  /** green: confirmed. red: refused. amber: a caution. neutral: the chain adds nothing. */
  colour: "green" | "red" | "amber" | "neutral";
  reason: string;
  /** This verifier's own known registry for the chain was read (an explicit other registryAddress is not). */
  keyOfRegistry: boolean;
  /** True when the reading withholds the key: overall cannot read verified. */
  withholds: boolean;
  /** keccak256(JCS(claim) || salt), when the bundle carries a readable salt. */
  fingerprint?: string;
  /** The key window keyOf returned (unix seconds as decimal strings). */
  record?: { validFrom: string; anchoredAt: string; retiredAt: string; voidedAt: string };
  /** grantedAt in unix seconds, or null when it does not parse. */
  grantedAt: number | null;
  /** The verifier's clock, unix seconds. */
  now: number;
}

export interface SignedAnchorReading {
  /**
   *   bound        the bundle's root equals the signed root and every bundle ref is a signed ref
   *   contradicts  the bundle's root differs, or it carries a ref the signature does not (consentAnchor fails)
   *   malformed    a signed member is missing or malformed, or the bundle carries no root: no anchor is tied
   */
  binding: "bound" | "contradicts" | "malformed";
  /** The signed root and refs ("" and [] when malformed). The chain is read on these, never on the bundle's. */
  merkleRoot: string;
  consentRefs: string[];
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
  /** Method references (`#kms-1` or the full id) the company key that checks proof[0] must appear under. */
  assertionMethod?: unknown[];
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
  /**
   * A gateway YOU name, asked FIRST, before `ipfsGateways`: a prefix to which the CID is appended
   * (`https://host/ipfs/`), a template carrying `{cid}`, or a function of the CID. It is trusted no more than
   * any other: its bytes count only once they re-encode to the CID.
   */
  ipfsGateway?: string | ((cid: string) => string);
  /**
   * The gateways asked in order after `ipfsGateway`, each a prefix or a `{cid}` template. Replaces the default
   * list (Lighthouse). A gateway that errors, sends more than one block (262144 bytes) or sends bytes that do not
   * re-encode to the CID delivers nothing, and the next one is asked.
   */
  ipfsGateways?: readonly string[];
  /**
   * The verifier's clock, in milliseconds since the epoch (default `Date.now`). Read once per verification, to tell
   * a person's key not anchored YET from one never recorded (72 hours after grantedAt). Pin it in tests.
   */
  now?: () => number;
  /**
   * JSON-RPC URL for the opt-in on-chain checks (documentAnchor, consentAnchor, companyKeyRegistry,
   * citizenKeyChain). Omit to skip them: without it, nothing is read on chain and no result changes.
   */
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
