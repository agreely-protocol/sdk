// The headline: an offline-first, honest consent-receipt verifier.
//
// "Offline-first", not "fully offline": the signature/assertion checks need the
// signing key from the issuer/citizen DID document. By default that is one HTTPS
// resolution (or supply the DID document(s) via an injected `resolver` for a truly
// air-gapped verify). The IPFS disclosure copy and the on-chain anchors are the
// OPT-IN extra network calls. When a DID cannot be resolved, the affected check is
// reported "unavailable" (inconclusive), never "fail" (a real tamper).
//
// The input is a bare receipt OR the verification bundle Agreely issues with it
// ({ version, receipt, signedOffer, merkleRoot, consentRefs, didDocuments }). The
// bundle is detected, never misread as a receipt.
//
// A recorded receipt (paper or telephone) is fully offline-sound: strip the proof,
// JCS-canonicalize the body, decode the multibase proofValue to a 64-byte Ed25519
// signature, resolve the issuer DID to its key, and verify. That proves the COMPANY
// attested to what the body says; it does NOT prove a human signed.
//
// A passkey receipt is verifiable ONLY from its bundle, mirroring the app's
// /verify page (public/assets/verify/verify-core.js): proof[0] is the company
// signature over JCS(signedOffer), the receipt must match that offer field by
// field, and the passkey challenge is recomputed as
// keccak256(JCS({issuer, subject, requestId, action, grantedAt, merkleRoot}) || nonce).
// The key the assertion verified with must then be the person's at grantedAt (citizen-key.js): their DID
// document lists it under `authentication` with a window covering that date. And grantedAt, which the passkey
// signer chooses, must lie inside the window of the offer the company signed.
// A BARE passkey receipt omits the offer, the nonce and the Merkle root, so its
// assertion cannot be tied to its content: it is reported "unbound" and the overall
// verdict "incomplete", never the verdict a genuine bundle gets.
//
// TRAP: the keys always come from the resolver, never from bundle.didDocuments.
// Anyone can write a bundle that carries their own key under someone else's DID.
//
// The input is hostile: anything this verifier cannot read (a bundle of another version,
// a non-object receipt or offer, a passkey receipt carrying a field the issuer never writes,
// a number, nesting past MAX_INPUT_DEPTH) reads "malformed", and verify() resolves on every
// input, a deep one included.

import { canonicalize } from "../crypto/jcs.js";
import {
  base64urlDecode,
  bytesEqual,
  decodeEd25519PublicKeyMultibase,
  hexDecode,
  multibaseDecode,
} from "../crypto/encoding.js";
import { keccak256, keccak256Hex } from "../crypto/keccak.js";
import { parseCoseKey, verifyEd25519, verifyWebAuthnAssertion } from "../crypto/verify.js";
import { createHash } from "node:crypto";
import {
  CHAIN_WITHHOLDS,
  citizenHalfReading,
  citizenKeyChainState,
  citizenKeyFingerprint,
  decodeKeyRecord,
  grantedAtSeconds,
  keyOfCalldata,
  parseCitizenKeySalt,
  type CitizenKeyChainState,
  type KeyRecord,
} from "./citizenKeyChain.js";
import {
  companyDomainFromDoc,
  companyKeyOfCalldata,
  companyKeyStatusOf,
  companyKeyVerdict,
  decodeCompanyDid,
  domainHashOf,
  getCompanyDidCalldata,
  receiptClockOf,
  type ReceiptClock,
} from "./companyKey.js";
import { DEFAULT_IPFS_GATEWAYS, readPinnedFile, type IpfsGateway } from "./ipfs.js";
import { recordedRootBinding, recordedShapeOf } from "./recorded.js";
import type {
  CheckStatus,
  CitizenKeyReading,
  CompanyKeyReading,
  ConsentAnchorRecord,
  DidDocument,
  DocumentAnchorRecord,
  DidVerificationMethod,
  ReceiptType,
  ReceiptVerification,
  VerifyReceiptOptions,
} from "./types.js";

// The host that SERVES company did:web documents, i.e. the Agreely WEB (dashboard)
// tier: `did:web:app.agreely.ca:c:{slug}` resolves to
// `https://app.agreely.ca/c/{slug}/did.json`.
//
// It is NOT the apex `agreely.ca`, which is the marketing site and 404s on that path.
// `GET /c/{slug}/did.json` is routed on MODE=WEB only; the api and citizen tiers do
// not serve it.
const DEFAULT_COMPANY_HOST = "app.agreely.ca";

// The base URL of the CITIZEN tier, which serves `GET /did/{did}` for
// `did:agreely:citizen:*`. It is NOT the api tier: `GET /did/{did}` is routed on
// MODE=CITIZEN only, and api.agreely.ca 404s on it, which made every citizen assertion
// resolve to "unavailable" by default.
const DEFAULT_CITIZEN_BASE = "https://my.agreely.ca";
// The AgreelyRegistry each chain is read from, by eth_call. EIP-55 checksummed.
//
// KEEP THIS IN SYNC WITH THE DEPLOYMENTS. It is pinned BY HAND (the SDK reads no config), so a
// redeploy does NOT propagate here on its own. A stale address is SILENT and WORSE than a missing
// one: a superseded contract still exists and still answers, it just holds no anchors.
// registryReads.test.ts pins this map, and refuses every address that is not on it.
//
// Each chain reads its one known registry. An explicit registryAddress overrides it on any chain.
const REGISTRY_BY_CHAIN: Readonly<Record<number, string>> = {
  8453: "0x6F2cF94045cF0cbDD94338882c34D183575023E9", // Base mainnet, deployed at block 53113531
  84532: "0xf25D3F8E73648C797Be2CCCD428061f357567b9A", // Base Sepolia, deployed at block 50213158
};
// Base mainnet (chainId 8453) is the default chain. Base Sepolia (84532) is an explicit opt-in for testing.
const DEFAULT_CHAIN_ID = 8453;
const REGISTRY_SELECTOR = keccak256Hex("registry(bytes32)").slice(0, 10);
// rootOf(bytes32) -> (tag, anchoredAt, anchoredBlock, lane). A consent document is keyed keccak256(bytes(cid)),
// lane 3, always untagged.
const ROOT_OF_SELECTOR = keccak256Hex("rootOf(bytes32)").slice(0, 10);
// AnchorBatch(bytes32 indexed merkleRoot, uint256 refCount, uint64 timestamp): one log per consent's anchor transaction.
const ANCHOR_BATCH_TOPIC = keccak256Hex("AnchorBatch(bytes32,uint256,uint64)");
// The clock skew a consent anchor allows a signing instant, in seconds (citizenKeyChain SKEW).
const ANCHOR_SKEW_SECONDS = 300;
const DOCUMENT_LANE = 3;
const ROOT_LANES: Readonly<Record<number, string>> = { 1: "an audit-family root", 2: "a cookie consent root" };
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RPC_DEADLINE_MS = 30_000;
// A malformed bundle must not spray unbounded RPC calls.
const MAX_CONSENT_REFS = 32;
// A genuine bundle nests about eight levels deep. Past this, the recursive canonicalizer would
// overflow the stack on a few kilobytes of input.
const MAX_INPUT_DEPTH = 64;
// Every Agreely citizen is did:agreely:citizen:* (app Citizen\Did), the suffix URL-safe because it is joined to
// the resolver path as is (citizen-key.js isAgreelyCitizenDid). A passkey under any other subject is not checked:
// a did:web subject would let anyone serve their own key from their host.
const CITIZEN_DID_PREFIX = "did:agreely:citizen:";
const CITIZEN_DID_PATTERN = /^did:agreely:citizen:(?!\.+$)[A-Za-z0-9._-]{1,128}$/;
// An instant as Agreely writes one: a calendar date (UTC midnight) or an RFC 3339 date-time with a zone. Anything
// else is unreadable, which never confirms a key nor satisfies a window.
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
// The top level of a passkey receipt as ConsentReceipt::build writes it. The offer carries
// only issuer and validUntil of these; type and @context are constants, the id is unsigned.
const PASSKEY_RECEIPT_KEYS = new Set(["@context", "type", "id", "issuer", "validFrom", "validUntil", "credentialSubject", "proof"]);
const PASSKEY_RECEIPT_TYPE = ["VerifiableCredential", "ConsentReceipt"];
const PASSKEY_RECEIPT_CONTEXT = ["https://www.w3.org/ns/credentials/v2", "https://agreely.ca/credentials/consent/v1"];
const BUNDLE_VERSION = "1";
// No signature covers a proof's own members, so they are held to the exact shape the issuer writes
// (CompanyDidService::dataIntegrityProof, ConsentReceipt::build): exactly these keys, every value a string.
const ISSUER_PROOF_KEYS = ["type", "cryptosuite", "created", "verificationMethod", "proofPurpose", "proofValue"];
const CITIZEN_PROOF_KEYS = ["type", "verificationMethod", "nonce", "challenge", "authenticatorData", "clientDataJSON", "signature"];

const ALLOWED_CONSENT_KEYS = new Set([
  "action",
  "items",
  "requestId",
  "grantedAt",
  "document",
  "disclosureHash",
  "declinedItems",
  "disclosureVersion",
  "legalBasis",
  "minor",
]);

type RpcOutcome = { ok: true; result: unknown } | { ok: false; reason: string };
/** The deadline of one verification's RPC sequence, set by its first call. */
/**
 * One verification's on-chain session: the RPC deadline, the registry a bundle names (read only to refuse a
 * mismatch, never to choose what is read), and the records the anchor checks read, for the result.
 */
type ChainSession = {
  deadline: number | null;
  namedRegistry: NamedRegistry | null;
  // Set when the bundle names a registry this SDK does not read: the anchors are then never verified.
  registryRefused?: boolean;
  documentRecord?: DocumentAnchorRecord;
  consentRecords?: ConsentAnchorRecord[];
  consentCounts?: ReceiptVerification["consentAnchorCounts"];
  // The company key that verified proof[0], and the DID document it was resolved from.
  signer?: { key: Uint8Array; doc: DidDocument };
  // The consent anchor under the trusted root: its earliest and latest anchor times, when a cell matched it.
  consentTiming?: { earliest: number; latest: number };
  disclosureGateway?: string;
};
type NamedRegistry = { chainId: string; registry: string };

/** Thrown inside a verification to end it as "malformed"; never escapes verify(). */
class MalformedInput extends Error {}

/**
 * Is `value` a verification bundle? Version "1", a `receipt` object, and a `signedOffer` object
 * when it carries one (a recorded receipt's bundle has none). Any other top-level key, `type`
 * included, does not make it a bare receipt.
 */
export function isVerificationBundle(value: unknown): boolean {
  return classifyInput(value) === "bundle";
}

function classifyInput(value: unknown): "bundle" | "receipt" | "malformed-bundle" | "malformed" {
  if (!isPlainObject(value)) return "malformed";
  const bundleShaped = "receipt" in value || "signedOffer" in value || "version" in value;
  if (!bundleShaped) return "receipt";
  // A receipt VC carries its proof at the top level; a bundle never does.
  if ("proof" in value && !("receipt" in value)) return "receipt";
  const offerOk = !("signedOffer" in value) || isPlainObject(value["signedOffer"]);
  return value["version"] === BUNDLE_VERSION && isPlainObject(value["receipt"]) && offerOk ? "bundle" : "malformed-bundle";
}

/** The verifier. `Agreely.verifyReceipt` is a thin static over this. */
export class ReceiptVerifier {
  constructor(private readonly opts: VerifyReceiptOptions = {}) {
    // The options are the caller's code, not hostile input: a wrong type is a programming error and throws.
    if (!isPlainObject(opts)) throw new TypeError("ReceiptVerifier options must be an object.");
  }

  /** Verify a parsed receipt or verification bundle. Always resolves; never throws on bad input. */
  async verify(input: unknown): Promise<ReceiptVerification> {
    const kind = classifyInput(input);
    try {
      if (kind === "malformed") throw new MalformedInput("the input is not a JSON object");
      if (kind === "malformed-bundle") throw new MalformedInput(bundleShapeFailure(input as Record<string, unknown>));
      if (exceedsDepth(input, MAX_INPUT_DEPTH)) {
        throw new MalformedInput(`the input nests deeper than ${String(MAX_INPUT_DEPTH)} levels`);
      }
      return await this.verifyShaped(input as Record<string, unknown>, kind === "bundle");
    } catch (err) {
      const reason = err instanceof MalformedInput ? err.message : `it could not be processed (${errorName(err)})`;
      const inBundle = kind === "bundle" || kind === "malformed-bundle";
      const r = asObject(inBundle ? asObject(input)["receipt"] : input);
      return malformedResult(inBundle ? "bundle" : "receipt", receiptType(r), reason);
    }
  }

  private async verifyShaped(input: Record<string, unknown>, isBundle: boolean): Promise<ReceiptVerification> {
    const bundle = isBundle ? input : null;
    const r = bundle ? asObject(bundle["receipt"]) : input;
    const session: ChainSession = { deadline: null, namedRegistry: bundle ? namedRegistryOf(bundle) : null };
    const type = receiptType(r);
    const notes: string[] = [];
    if (bundle) {
      notes.push(
        "Read as a verification bundle. Keys are resolved from the issuer and citizen DIDs (or your resolver), " +
          "never taken from the bundle's own didDocuments, which anyone can write.",
      );
    }

    if (type !== "citizen") {
      return this.verifyRecorded(r, type, bundle, notes, session);
    }
    if (!bundle) return this.verifyBarePasskey(r, notes, session);
    const offer = bundle["signedOffer"];
    const merkleRoot = bundle["merkleRoot"];
    if (!isPlainObject(offer) || Object.keys(offer).length === 0) {
      throw new MalformedInput("the bundle carries a passkey receipt but no signedOffer object");
    }
    if (typeof merkleRoot !== "string" || merkleRoot === "") {
      throw new MalformedInput("the bundle carries a passkey receipt but no merkleRoot string");
    }
    const outside = passkeyFieldOutsideFormat(r);
    if (outside !== null) throw new MalformedInput(outside);
    return this.verifyPasskeyBundle(r, bundle, offer, merkleRoot, notes, session);
  }

  /** A paper (company_attested) or telephone (company_documented) receipt: the company signed the body itself. */
  private async verifyRecorded(
    r: Record<string, unknown>,
    type: "company_attested" | "company_documented",
    bundle: Record<string, unknown> | null,
    notes: string[],
    session: ChainSession,
  ): Promise<ReceiptVerification> {
    // verify-core.js receiptModeOf: a version this verifier does not read is refused unread, never judged.
    const shape = recordedShapeOf(r, type);
    if (shape.kind === "unknown-version") {
      throw new MalformedInput(`the receipt's receiptVersion ${shape.version} is not a version this verifier reads`);
    }
    const companySignature = await this.verifyCompanySignature(r, notes, type, session);
    notes.push(
      type === "company_attested"
        ? "A company-attested receipt carries no citizen passkey assertion, so citizenAssertion is not applicable."
        : "A verbal (company-documented) receipt carries no citizen passkey assertion, so citizenAssertion is not applicable.",
    );
    // The signature is taken over the receipt body itself, so it IS the integrity check, except for the proof's own
    // members, which nothing signs, and a body its issuer never writes, which a valid signature does not make one.
    const proofFailure = recordedProofFailure(r);
    let receiptIntegrity = companySignature;
    if (proofFailure !== null) {
      receiptIntegrity = "fail";
      notes.push(`Receipt integrity FAILED: ${proofFailure}.`);
    }
    if (shape.kind === "mismatch") {
      receiptIntegrity = "fail";
      notes.push(`Receipt integrity FAILED: ${shape.reason}, so it is not a receipt its issuer writes.`);
    }
    const cellLabelBinding = assessRecordedCellLabels(companySignature, notes);
    const disclosureCopy = await this.verifyRecordedDisclosureCopy(r, notes, session);
    const documentAnchor = await this.verifyDocumentAnchor(r, notes, session);

    // The issuer is judged FIRST, on its own date: a signed anchor never bounds the instant its own signer chose.
    const company = this.opts.rpcUrl
      ? await this.verifyCompanyKeyRegistry(r, { anchoredAt: null, issuerDatedOnly: true }, companySignature, notes, session)
      : null;

    let consentAnchor: CheckStatus = "skipped";
    let signedAnchor: ReceiptVerification["signedAnchor"];
    const binding = bundle && companySignature === "pass" && receiptIntegrity === "pass"
      ? recordedRootBinding(r, bundle, collectConsentRefs(bundle))
      : null;
    if (r["receiptVersion"] !== "4") {
      notes.push(
        "consentAnchor skipped: a paper or telephone receipt signs no anchor before version 4, so the withdrawal of " +
          "this consent is not checked.",
      );
    } else if (bundle === null) {
      notes.push(
        "consentAnchor skipped: a version 4 receipt's anchor is read with its verification bundle, which carries the " +
          "merkleRoot and consentRefs beside it.",
      );
    } else if (binding === null || binding.binding === "preV4") {
      notes.push("consentAnchor skipped: the company signature did not hold, so no signed anchor ties this receipt to the chain.");
    } else {
      signedAnchor = { binding: binding.binding, merkleRoot: binding.merkleRoot, consentRefs: binding.consentRefs };
      consentAnchor = await this.verifySignedAnchor(r, signedAnchor, company, notes, session);
    }

    let overall: ReceiptVerification["overall"];
    const decisive = [companySignature, receiptIntegrity, disclosureCopy, documentAnchor, consentAnchor, company?.status];
    if (decisive.includes("fail")) overall = "failed";
    else if (companySignature === "unavailable" || session.registryRefused || (company !== null && company.status !== "pass")) {
      overall = "unavailable";
    }
    // A telephone receipt is the organisation's word, authenticated: never more than partial.
    else if (type === "company_documented") overall = "partial";
    else overall = consentAnchor === "withdrawn" ? "withdrawn" : "verified";

    return {
      input: bundle ? "bundle" : "receipt",
      receiptType: type,
      companySignature,
      receiptIntegrity,
      citizenAssertion: "unsupported",
      disclosureCopy,
      documentAnchor,
      consentAnchor,
      cellLabelBinding,
      overall,
      ...withdrawalOf(consentAnchor, session),
      ...anchorRecords(session),
      ...(company ? { companyKeyRegistry: company.status, ...(company.reading ? { companyKey: company.reading } : {}) } : {}),
      ...(signedAnchor ? { signedAnchor } : {}),
      notes,
    };
  }

  /**
   * A version 4 recorded receipt's own anchor (ui.js consentChainRequest): a bundle that contradicts the signature
   * fails with nothing read; a bound one is read on the SIGNED root and refs, and only once the registry confirms
   * the company key that signed them. A matching anchor older than the signing instant is not this receipt's.
   */
  private async verifySignedAnchor(
    r: Record<string, unknown>,
    binding: { binding: "bound" | "contradicts" | "malformed"; merkleRoot: string; consentRefs: string[] },
    company: CompanyKeyCheck | null,
    notes: string[],
    session: ChainSession,
  ): Promise<CheckStatus> {
    if (binding.binding === "contradicts") {
      notes.push(
        "consentAnchor FAILED: the receipt signs its anchor batch, and the bundle's own merkleRoot or consentRefs " +
          "contradict it (another root, or a ref the signature does not carry). Nothing was read on chain.",
      );
      return "fail";
    }
    if (binding.binding === "malformed") {
      notes.push(
        "consentAnchor skipped: the version 4 receipt's signed anchor is missing or malformed, or the bundle carries " +
          "no merkleRoot, so no anchor is tied to this receipt.",
      );
      return "skipped";
    }
    if (!this.opts.rpcUrl) {
      notes.push("consentAnchor skipped: pass an rpcUrl to read the consent's on-chain record.");
      return "skipped";
    }
    if (company === null || company.reading?.verdict !== "authentic") {
      notes.push(
        "consentAnchor UNAVAILABLE: the receipt's anchor hangs on its company signature, and the registry did not " +
          "confirm the company key at the instant it signed, so the signed root is not trusted and nothing was read.",
      );
      return "unavailable";
    }
    const status = await this.verifyConsentAnchor(binding.consentRefs, binding.merkleRoot, null, { cells: 0, countAnchoredRefs: false }, notes, session);
    const signedAt = Date.parse(signingInstantOf(r) ?? "");
    const timing = session.consentTiming;
    if (
      (status === "pass" || status === "withdrawn" || status === "unavailable") &&
      timing !== undefined && Number.isFinite(signedAt) &&
      timing.earliest < Math.floor(signedAt / 1000) - ANCHOR_SKEW_SECONDS
    ) {
      notes.push(
        `consentAnchor FAILED: the chain anchored this root at ${String(timing.earliest)}, before the receipt was ` +
          "signed: a version 4 receipt signs a root before it is anchored, so this anchor is not this receipt's.",
      );
      return "fail";
    }
    return status;
  }

  /** A passkey receipt WITHOUT its signed offer and Merkle root: nothing binds the assertion to the content. */
  private async verifyBarePasskey(r: Record<string, unknown>, notes: string[], session: ChainSession): Promise<ReceiptVerification> {
    notes.push(
      "Company signature UNSUPPORTED on a bare passkey receipt: the company signed the offer, which travels only in " +
        "the verification bundle.",
    );
    notes.push(
      "Receipt integrity UNSUPPORTED on a bare passkey receipt: nothing on the receipt alone binds its purposes, cells, " +
        "dates, document or issuer to a signature.",
    );
    const passkey = await this.verifyPasskeySignature(r, notes);
    let citizenAssertion: CheckStatus = passkey.status;
    if (passkey.status === "pass") {
      citizenAssertion = "unbound";
      notes.push(
        `Citizen assertion UNBOUND: the passkey signature verifies against ${passkey.vm}, but its challenge is computed ` +
          "from a requestId, a Merkle root and a nonce the bare receipt does not carry, so nothing ties it to this " +
          "receipt's content. A receipt rewritten around a genuine assertion reads the same.",
      );
    }
    notes.push(
      "Cell labels UNSUPPORTED on a bare passkey receipt: the category/purpose labels are covered only by the company " +
        "signature over the offer, which travels in the verification bundle. Do NOT trust the displayed labels.",
    );
    const cellLabelBinding: CheckStatus = "unsupported";
    notes.push(
      "disclosureCopy UNSUPPORTED on a bare passkey receipt: its disclosureHash (and a v2 legalBasis) is signed by " +
        "nobody, so no copy can be checked against it.",
    );
    const disclosureCopy: CheckStatus = "unsupported";
    const documentAnchor = await this.verifyDocumentAnchor(r, notes, session);
    notes.push("consentAnchor skipped: without the bundle there is no consentRef and no bound Merkle root to read on chain.");

    const overall: ReceiptVerification["overall"] =
      citizenAssertion === "fail" || documentAnchor === "fail" ? "failed" : "incomplete";
    notes.push(
      "INCOMPLETE: a passkey receipt cannot be verified on its own. Verify the verification bundle issued with it " +
        "(the file that carries receipt, signedOffer and merkleRoot).",
    );

    return {
      input: "receipt",
      receiptType: "citizen",
      companySignature: "unsupported",
      receiptIntegrity: "unsupported",
      citizenAssertion,
      disclosureCopy,
      documentAnchor,
      consentAnchor: "skipped",
      cellLabelBinding,
      overall,
      withdrawal: "not_checked",
      ...anchorRecords(session),
      notes,
    };
  }

  /** A passkey receipt with its bundle: the same checks as the app's /verify page. */
  private async verifyPasskeyBundle(
    r: Record<string, unknown>,
    bundle: Record<string, unknown>,
    offer: Record<string, unknown>,
    merkleRoot: string,
    notes: string[],
    session: ChainSession,
  ): Promise<ReceiptVerification> {
    const companySignature = await this.verifyOfferSignature(r, offer, notes, session);
    const fieldFailure = integrityFailure(r, offer);
    const fieldIntegrity: CheckStatus = fieldFailure === null ? "pass" : "fail";
    // The passkey signer chooses grantedAt, so only the company-signed offer's own window bounds it.
    const window = fieldIntegrity === "pass" && companySignature === "pass" ? offerWindowOf(r, offer) : null;
    const receiptIntegrity = checkReceiptIntegrity(fieldFailure, window, notes);
    const outsideWindow = window !== null && window.failure !== null;

    const passkey = await this.verifyPasskeySignature(r, notes);
    let citizenAssertion: CheckStatus = passkey.status;
    if (passkey.status === "pass") {
      const bound = citizenChallengeBinds(r, offer, merkleRoot, passkey.challenge);
      // Only a bound assertion makes grantedAt the person's own date, so only then is the key judged against it,
      // and only at a date the offer allows: a key confirmed at a date in doubt proves nothing.
      if (bound === "ok" && outsideWindow) {
        citizenAssertion = "unavailable";
        notes.push(
          "Citizen assertion NOT EVALUATED: the acceptance date (grantedAt) cannot be placed inside the company-signed " +
            "offer's window, so the person's key is not evaluated at that date.",
        );
      } else if (bound === "ok" && passkey.standing !== "confirmed") {
        citizenAssertion = "fail";
        notes.push(`Citizen assertion FAILED: ${CITIZEN_KEY_REFUSAL[passkey.standing ?? "unlisted"]}`);
      } else if (bound === "ok") {
        notes.push(
          `Citizen assertion verified and bound: the passkey ${passkey.vm} signed the challenge recomputed from this ` +
            "receipt's issuer, subject, requestId, action and grantedAt, the bundle's Merkle root and the offer's nonce. " +
            "The citizen's DID document lists that key under authentication, valid at grantedAt.",
        );
      } else {
        citizenAssertion = "fail";
        notes.push(
          bound === "mismatch"
            ? "Citizen assertion FAILED: the passkey signature verifies, but the challenge it signed does not recompute " +
                "from this receipt's issuer, subject, requestId, action and grantedAt with the bundle's Merkle root and " +
                "nonce. The assertion belongs to another consent."
            : "Citizen assertion FAILED: the challenge cannot be recomputed (a context field, the Merkle root or the " +
                "offer's nonce is missing or malformed).",
        );
      }
    }

    let cellLabelBinding: CheckStatus;
    if (companySignature === "pass" && fieldIntegrity === "pass") {
      cellLabelBinding = "pass";
      notes.push(
        "Cell labels bound: every accepted and declined cell is an exact item of the company-signed offer.",
      );
    } else if (companySignature === "fail" || fieldIntegrity === "fail") {
      cellLabelBinding = "fail";
      notes.push("Cell labels UNBOUND: the receipt's cells are not proven to be items of a verified company offer.");
    } else {
      cellLabelBinding = "unavailable";
      notes.push(
        "Cell-label binding UNVERIFIABLE: the issuer DID could not be resolved, so the offer that binds the labels " +
          "could not be checked.",
      );
    }

    const disclosureCopy = await this.verifyOfferDisclosureCopy(offer, companySignature, notes, session);
    const documentAnchor = await this.verifyDocumentAnchor(r, notes, session);

    // The person's key on chain first: a registry that voids it, or places grantedAt outside its window, leaves the
    // bundle's root untrusted, whatever the DID document says (ui.js receiptRootTrusted).
    const rpcUrl = this.opts.rpcUrl;
    const keyChain = rpcUrl && citizenAssertion === "pass" ? await this.readCitizenKeyChain(r, bundle, passkey.coseHex ?? "", session) : null;
    const keyRefused = keyChain !== null && (keyChain.state === "voided" || keyChain.state === "notInForce");
    const untrusted = citizenAssertion !== "pass"
      ? "consentAnchor skipped: the bundle's Merkle root is not bound by a verified passkey assertion, so no on-chain " +
        "record can be tied to this receipt."
      : keyRefused
        ? "consentAnchor skipped: the registry records the person's key as voided, or not in force at grantedAt, so " +
          "the bundle's Merkle root is not trusted and no on-chain record can be tied to this receipt."
        : null;
    const consentAnchor = await this.verifyConsentAnchor(
      collectConsentRefs(bundle), merkleRoot, untrusted, { cells: acceptedCellCount(r), countAnchoredRefs: true }, notes, session,
    );

    // The company key at grantedAt, bounded by the latest anchor holding the trusted root (issuer.js receiptClockOf).
    const timing = session.consentTiming;
    const clock = receiptClockOf(timing ? { rootMatches: true, anchoredAt: timing.latest } : null);
    const company = rpcUrl ? await this.verifyCompanyKeyRegistry(r, clock, companySignature, notes, session) : null;

    let citizenKeyChain: CheckStatus | undefined;
    let citizenKey: CitizenKeyReading | undefined;
    if (rpcUrl && keyChain === null) {
      citizenKeyChain = "skipped";
      notes.push("citizenKeyChain skipped: the person's assertion did not verify, so there is no key to look up on chain.");
    } else if (keyChain !== null) {
      const half = citizenHalfReading({
        chainState: keyChain.state,
        didStanding: "confirmed",
        consentAnchor: timing ? { rootMatches: true, anchoredAt: timing.latest, earliestAnchoredAt: timing.earliest } : null,
        G: keyChain.G,
        keyOfRegistry: keyChain.keyOfRegistry,
      });
      citizenKey = {
        chainState: keyChain.state,
        colour: half.colour,
        reason: half.reason,
        keyOfRegistry: keyChain.keyOfRegistry,
        withholds: half.colour === "amber" && CHAIN_WITHHOLDS.has(half.reason),
        ...(keyChain.fp ? { fingerprint: keyChain.fp } : {}),
        ...(keyChain.record ? { record: recordStrings(keyChain.record) } : {}),
        grantedAt: keyChain.G,
        now: keyChain.now,
      };
      citizenKeyChain =
        half.colour === "green" ? "pass"
        : half.colour === "red" ? "fail"
        : half.colour === "neutral" && keyChain.state === "notLinked" ? "skipped"
        : "unavailable";
      notes.push(citizenKeyNote(citizenKey));
    }

    let overall: ReceiptVerification["overall"];
    const checks = [companySignature, receiptIntegrity, citizenAssertion, disclosureCopy, documentAnchor, consentAnchor, citizenKeyChain, company?.status];
    // A bundle that names a registry this SDK does not read is never verified, however sound its signatures.
    if (checks.includes("fail")) overall = "failed";
    else if (
      companySignature === "pass" && receiptIntegrity === "pass" && citizenAssertion === "pass" && !session.registryRefused &&
      (company === null || company.status === "pass") && citizenKey?.withholds !== true
    ) {
      overall = consentAnchor === "withdrawn" ? "withdrawn" : "verified";
    } else overall = "unavailable";

    return {
      input: "bundle",
      receiptType: "citizen",
      companySignature,
      receiptIntegrity,
      citizenAssertion,
      disclosureCopy,
      documentAnchor,
      consentAnchor,
      cellLabelBinding,
      overall,
      ...withdrawalOf(consentAnchor, session),
      ...anchorRecords(session),
      ...(company ? { companyKeyRegistry: company.status, ...(company.reading ? { companyKey: company.reading } : {}) } : {}),
      ...(citizenKeyChain ? { citizenKeyChain, ...(citizenKey ? { citizenKey } : {}) } : {}),
      notes,
    };
  }

  /**
   * The person's key on chain: one keyOf(fingerprint) on the registry this verifier reads. The salt is the bundle's
   * top-level citizenKeySalt; nothing else in the file chooses what is read or where. Never throws.
   */
  private async readCitizenKeyChain(
    r: Record<string, unknown>,
    bundle: Record<string, unknown>,
    coseHex: string,
    session: ChainSession,
  ): Promise<{ state: CitizenKeyChainState; fp: string; record: KeyRecord | null; G: number | null; now: number; keyOfRegistry: boolean }> {
    const consent = asObject(asObject(r["credentialSubject"])["consent"]);
    const G = grantedAtSeconds(consent["grantedAt"]);
    const saltField = Object.prototype.hasOwnProperty.call(bundle, "citizenKeySalt") ? bundle["citizenKeySalt"] : undefined;
    const clock = this.opts.now ?? Date.now;
    const now = Math.floor(clock() / 1000);
    const target = this.registryToRead(session);
    const known = REGISTRY_BY_CHAIN[this.chainId()];
    const keyOfRegistry = target.ok && known !== undefined && target.address.toLowerCase() === known.toLowerCase();
    const out = { state: citizenKeyChainState({ saltField, G }), fp: "", record: null, G, now, keyOfRegistry };
    const salt = parseCitizenKeySalt(saltField);
    if (salt.status !== "ok") return out;
    let fp: string;
    try {
      fp = citizenKeyFingerprint(asString(asObject(r["credentialSubject"])["id"]), coseHex, salt.salt);
    } catch {
      return { ...out, state: "unreadable" };
    }
    if (!target.ok) return { ...out, fp, state: "unreachable" };
    const call = await this.rpc(this.opts.rpcUrl!, "eth_call", [{ to: target.address, data: keyOfCalldata(fp) }, "latest"], session);
    const record = call.ok ? decodeKeyRecord(call.result) : null;
    return { ...out, fp, record, state: citizenKeyChainState({ saltField, record, rpcError: !call.ok, G, now }) };
  }

  /**
   * The company key that verified proof[0], on the company's domain at the instant it signed: companyKeyOf for its
   * window, getCompanyDid for the key the company holds today (issuer.js resolveIssuerAuthenticity). The domain and
   * the key come from the RESOLVED issuer document, never from the bundle.
   */
  private async verifyCompanyKeyRegistry(
    r: Record<string, unknown>,
    clock: ReceiptClock,
    companySignature: CheckStatus,
    notes: string[],
    session: ChainSession,
  ): Promise<CompanyKeyCheck> {
    const signer = session.signer;
    if (companySignature !== "pass" || signer === undefined) {
      notes.push("companyKeyRegistry skipped: no company key verified the signature, so there is no key to look up on chain.");
      return { status: "skipped" };
    }
    const keyId = "0x" + createHash("sha256").update(signer.key).digest("hex");
    const signedAtMs = Date.parse(signingInstantOf(r) ?? "");
    const signedAt = Number.isFinite(signedAtMs) ? Math.floor(signedAtMs / 1000) : null;
    const domain = companyDomainFromDoc(signer.doc);
    const base = { keyId, signedAt, boundedBy: clock.anchoredAt, notYetEffective: false };
    if (domain === null) {
      notes.push(
        "companyKeyRegistry UNAVAILABLE: the issuer DID document names no company domain (alsoKnownAs), so the " +
          "company key cannot be looked up on chain.",
      );
      return { status: "unavailable", reading: { verdict: "no-domain", domain: "", domainHash: "", ...base } };
    }
    const domainHash = domainHashOf(domain);
    const target = this.registryToRead(session);
    if (!target.ok) {
      notes.push(`companyKeyRegistry UNAVAILABLE: ${target.reason}`);
      return { status: "unavailable" };
    }
    const rpcUrl = this.opts.rpcUrl!;
    const [keyCall, didCall] = await Promise.all([
      this.rpc(rpcUrl, "eth_call", [{ to: target.address, data: companyKeyOfCalldata(domainHash, keyId) }, "latest"], session),
      this.rpc(rpcUrl, "eth_call", [{ to: target.address, data: getCompanyDidCalldata(domainHash) }, "latest"], session),
    ]);
    const record = keyCall.ok ? decodeKeyRecord(keyCall.result) : null;
    if (record === null) {
      notes.push(
        `companyKeyRegistry UNAVAILABLE: the company key's window on ${domain} could not be read ` +
          `(${keyCall.ok ? "the answer does not decode" : keyCall.reason}). This is NOT a refusal.`,
      );
      return { status: "unavailable", reading: { verdict: "unreachable", domain, domainHash, ...base } };
    }
    const pit = companyKeyVerdict(record, signedAt, clock);
    const did = didCall.ok ? decodeCompanyDid(didCall.result) : null;
    const rotated = pit.verdict === "authentic" && did !== null && did.keyId.toLowerCase() !== keyId;
    const reading: CompanyKeyReading = {
      verdict: pit.verdict,
      domain,
      domainHash,
      ...base,
      notYetEffective: pit.notYetEffective,
      ...(pit.window ? { window: { validFrom: pit.window.validFrom.toString(), retiredAt: pit.window.retiredAt.toString() } } : {}),
      ...(did ? { currentKeyId: did.keyId, rotated } : {}),
    };
    const status = companyKeyStatusOf(pit.verdict);
    notes.push(companyKeyNote(reading));
    return { status, reading };
  }

  /** RECORDED: verify the Ed25519 proof over the canonical receipt body. */
  private async verifyCompanySignature(
    r: Record<string, unknown>,
    notes: string[],
    type: "company_attested" | "company_documented",
    session: ChainSession,
  ): Promise<CheckStatus> {
    const issuer = asString(r["issuer"]);
    const proof = asObject(asArray(r["proof"])[0]);
    const vm = asString(proof["verificationMethod"]);
    const proofValue = asString(proof["proofValue"]);

    if (!issuer || !proofValue) {
      notes.push("Company signature check FAILED: the receipt is missing its issuer or proofValue.");
      return "fail";
    }

    // The exact bytes the signature was taken over: the receipt body with `proof` removed.
    const body: Record<string, unknown> = { ...r };
    delete body["proof"];
    let canonical: Uint8Array;
    try {
      canonical = new TextEncoder().encode(canonicalize(body));
    } catch (err) {
      throw new MalformedInput(`the receipt body cannot be canonicalized (${errorMessage(err)})`);
    }

    let signature: Uint8Array;
    try {
      signature = multibaseDecode(proofValue);
    } catch {
      notes.push("Company signature check FAILED: the proofValue is not a valid multibase signature.");
      return "fail";
    }

    const resolved = await this.resolveCompanyKey(issuer, vm);
    if (resolved.kind !== "key") return companyKeyRefused(resolved, issuer, vm, notes);
    const { key, vmId } = resolved;

    if (verifyEd25519(key, canonical, signature)) {
      session.signer = { key, doc: resolved.doc };
      notes.push(`Company signature verified against issuer DID ${issuer} (key ${vmId}).`);
      if (type === "company_documented") {
        const scriptVersion = asString(asObject(r["evidence"])["scriptVersion"]);
        notes.push(
          `This proves the ORGANISATION documented a consent given by telephone under script version ` +
            `${scriptVersion}. It does NOT prove the call happened, and there is no signed document: this is the ` +
            "weakest of the three tiers, so overall is at most PARTIAL.",
        );
      } else {
        const pdfHash = asString(asObject(r["evidence"])["pdfHash"]);
        notes.push(
          `This proves the company ATTESTED to a hand-signed PDF (hash ${pdfHash}); it does NOT prove a human signed.`,
        );
      }
      return "pass";
    }
    notes.push(
      `Company signature check FAILED against issuer DID ${issuer} (key ${vmId}): the canonical receipt body does not ` +
        "match the signature. The receipt was altered after signing or the wrong key was resolved.",
    );
    return "fail";
  }

  /** PASSKEY BUNDLE: proof[0] is the company's Ed25519 signature over JCS(signedOffer). */
  private async verifyOfferSignature(
    r: Record<string, unknown>,
    offer: Record<string, unknown>,
    notes: string[],
    session: ChainSession,
  ): Promise<CheckStatus> {
    const issuer = asString(r["issuer"]);
    const proof = asObject(asArray(r["proof"])[0]);
    const vm = asString(proof["verificationMethod"]);
    const proofValue = asString(proof["proofValue"]);

    if (!issuer || !proofValue || proof["cryptosuite"] !== "eddsa-jcs-2022") {
      notes.push("Company signature check FAILED: proof[0] is not an eddsa-jcs-2022 signature with an issuer and a proofValue.");
      return "fail";
    }
    if (vm.split("#")[0] !== issuer) {
      notes.push(`Company signature check FAILED: proof[0] names the key ${vm}, which does not belong to the issuer ${issuer}.`);
      return "fail";
    }
    let canonical: Uint8Array;
    try {
      canonical = new TextEncoder().encode(canonicalize(offer));
    } catch (err) {
      throw new MalformedInput(`the signed offer cannot be canonicalized (${errorMessage(err)})`);
    }
    let signature: Uint8Array;
    try {
      signature = multibaseDecode(proofValue);
    } catch {
      notes.push("Company signature check FAILED: the proofValue is not a valid multibase signature.");
      return "fail";
    }
    const resolved = await this.resolveCompanyKey(issuer, vm);
    if (resolved.kind !== "key") return companyKeyRefused(resolved, issuer, vm, notes);
    const { key, vmId } = resolved;
    if (verifyEd25519(key, canonical, signature)) {
      session.signer = { key, doc: resolved.doc };
      notes.push(`Company signature over the signed offer verified against issuer DID ${issuer} (key ${vmId}).`);
      return "pass";
    }
    notes.push(
      `Company signature check FAILED against issuer DID ${issuer} (key ${vmId}): the signed offer does not match the ` +
        "signature. The offer was altered after signing or the wrong key was resolved.",
    );
    return "fail";
  }

  /** The WebAuthn signature over authenticatorData || sha256(clientDataJSON), and clientDataJSON's own challenge. */
  private async verifyPasskeySignature(
    r: Record<string, unknown>,
    notes: string[],
  ): Promise<{ status: CheckStatus; vm: string; challenge: string; standing?: CitizenKeyStanding; coseHex?: string }> {
    const citizenDid = asString(asObject(r["credentialSubject"])["id"]);
    const proof = findWebAuthnProof(asArray(r["proof"]));
    if (!proof || !citizenDid) {
      notes.push("Citizen assertion FAILED: no WebAuthn assertion or citizen DID on the receipt.");
      return { status: "fail", vm: "", challenge: "" };
    }
    const vm = asString(proof["verificationMethod"]);
    const challenge = asString(proof["challenge"]);
    if (!CITIZEN_DID_PATTERN.test(citizenDid)) {
      notes.push(
        `Citizen assertion UNVERIFIABLE: the subject ${citizenDid} is not an Agreely citizen DID (${CITIZEN_DID_PREFIX}...), ` +
          "so no passkey key can be confirmed for it. Its key was not looked up; the assertion proves nothing.",
      );
      return { status: "unavailable", vm, challenge };
    }
    const doc = await this.resolveDid(citizenDid);
    if (!isPlainObject(doc) || doc.id !== citizenDid || !Array.isArray(doc.verificationMethod)) {
      notes.push(
        doc === null
          ? `Citizen assertion UNVERIFIABLE: could not resolve the citizen DID ${citizenDid} (passkey ${vm}) ` +
              "(network/resolution failure or key not found). This is INCONCLUSIVE, NOT a signature mismatch."
          : `Citizen assertion UNVERIFIABLE: what the resolver answered for ${citizenDid} is not that identity's DID ` +
              "document (another id, or no verificationMethod list). This is INCONCLUSIVE, NOT a signature mismatch.",
      );
      return { status: "unavailable", vm, challenge };
    }
    const key = citizenKeyOf(doc, vm);
    if (!key) {
      notes.push(`Citizen assertion FAILED: the DID document of ${citizenDid} holds no passkey (COSE) key.`);
      return { status: "fail", vm, challenge };
    }
    const coseHex = key.cose;

    let cose;
    let authData: Uint8Array;
    let clientDataJSON: Uint8Array;
    let signature: Uint8Array;
    try {
      cose = parseCoseKey(hexDecode(coseHex));
      authData = base64urlDecode(asString(proof["authenticatorData"]));
      clientDataJSON = base64urlDecode(asString(proof["clientDataJSON"]));
      signature = base64urlDecode(asString(proof["signature"]));
    } catch {
      notes.push("Citizen assertion FAILED: the assertion artifacts could not be decoded.");
      return { status: "fail", vm, challenge };
    }

    if (cose.alg === "unsupported") {
      notes.push(
        `Citizen assertion UNSUPPORTED: the passkey uses a COSE algorithm this offline verifier does not implement.`,
      );
      return { status: "unsupported", vm, challenge };
    }

    if (!clientDataChallengeMatches(clientDataJSON, challenge)) {
      notes.push("Citizen assertion FAILED: the signed clientDataJSON is not a webauthn.get over the proof's challenge.");
      return { status: "fail", vm, challenge };
    }
    if (!verifyWebAuthnAssertion(cose, authData, clientDataJSON, signature)) {
      notes.push("Citizen assertion FAILED: the WebAuthn signature did not verify against the resolved passkey.");
      return { status: "fail", vm, challenge };
    }
    const grantedAt = asString(asObject(asObject(r["credentialSubject"])["consent"])["grantedAt"]);
    return { status: "pass", vm: key.vmId, challenge, standing: citizenKeyStanding(doc, citizenDid, coseHex, grantedAt), coseHex };
  }

  /**
   * RECORDED: fetch the IPFS document body and match its disclosure to disclosureHash. On a recorded
   * receipt the disclosureHash and a v2 legalBasis sit inside the company-signed body. v2 hashes
   * {disclosure, legalBasis}; v1 (or absent) hashes the disclosure map alone.
   */
  private async verifyRecordedDisclosureCopy(r: Record<string, unknown>, notes: string[], session: ChainSession): Promise<CheckStatus> {
    const consent = asObject(asObject(r["credentialSubject"])["consent"]);
    const cid = asString(asObject(consent["document"])["ipfsCid"]);
    const disclosureHash = asString(consent["disclosureHash"]);

    if (!cid || !disclosureHash) {
      notes.push(
        "disclosureCopy skipped: the receipt carries no document.ipfsCid + disclosureHash pair to fetch and compare.",
      );
      return "skipped";
    }
    if (this.opts.verifyDisclosure !== true) {
      notes.push(disclosureNotRequestedNote());
      return "skipped";
    }

    const version = consent["disclosureVersion"];
    const receiptBasis = consent["legalBasis"];
    const hasBasis = receiptBasis !== undefined && receiptBasis !== null;
    if (version !== undefined && version !== "1" && version !== "2") {
      notes.push("disclosureCopy FAILED: the receipt declares an unknown disclosureVersion, so its preimage is not defined.");
      return "fail";
    }
    if (version !== "2" && hasBasis) {
      notes.push(
        "disclosureCopy FAILED: the receipt carries a legalBasis but no disclosureVersion 2, so the preimage it hashes is ambiguous.",
      );
      return "fail";
    }
    if (version === "2" && !isPlainObject(receiptBasis)) {
      // A v2 receipt is never checked with the v1 formula: a missing basis fails here, it does not fall back.
      notes.push(
        "disclosureCopy FAILED (disclosureVersion 2): the receipt declares a v2 disclosureHash but carries no legalBasis map, so the preimage cannot be rebuilt.",
      );
      return "fail";
    }
    return this.compareDisclosureCopy(cid, disclosureHash, version === "2" ? receiptBasis : undefined, notes, session);
  }

  /** PASSKEY BUNDLE: the copy is compared with the SIGNED offer's disclosureHash and legalBasis, never the receipt's. */
  private async verifyOfferDisclosureCopy(
    offer: Record<string, unknown>,
    companySignature: CheckStatus,
    notes: string[],
    session: ChainSession,
  ): Promise<CheckStatus> {
    const cid = asString(asObject(offer["document"])["ipfsCid"]);
    const disclosureHash = asString(offer["disclosureHash"]);
    if (!cid || !disclosureHash) {
      notes.push(
        "disclosureCopy skipped: the signed offer carries no document.ipfsCid + disclosureHash pair to fetch and compare.",
      );
      return "skipped";
    }
    if (this.opts.verifyDisclosure !== true) {
      notes.push(disclosureNotRequestedNote());
      return "skipped";
    }
    if (companySignature !== "pass") {
      notes.push(
        "disclosureCopy skipped: the company signature over the offer did not verify, so there is no signed disclosureHash to compare the copy with.",
      );
      return "skipped";
    }
    const basis = offer["legalBasis"];
    return this.compareDisclosureCopy(cid, disclosureHash, basis === undefined || basis === null ? undefined : basis, notes, session);
  }

  /**
   * Fetch the IPFS document from the gateways in order and compare sha256(JCS(preimage)) with `disclosureHash`.
   * `basis` set = the v2 preimage. Only bytes that re-encode to the CID are the document: a hash mismatch on them
   * fails, and anything a gateway sends that is not the CID's file moves to the next gateway.
   */
  private async compareDisclosureCopy(
    cid: string,
    disclosureHash: string,
    basis: unknown,
    notes: string[],
    session: ChainSession,
  ): Promise<CheckStatus> {
    const gateways: IpfsGateway[] = [
      ...(this.opts.ipfsGateway !== undefined ? [this.opts.ipfsGateway] : []),
      ...(this.opts.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS),
    ];
    if (gateways.length === 0) {
      notes.push(`disclosureCopy UNAVAILABLE: no IPFS gateway is configured to fetch CID ${cid}. This is NOT a hash mismatch.`);
      return "unavailable";
    }
    const label = basis !== undefined ? " (disclosureVersion 2: {disclosure, legalBasis})" : "";
    const judge = (bytes: Uint8Array): { status: "pass" | "fail"; detail: string } => {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return { status: "fail", detail: "is not a JSON document, so it carries no disclosure to compare" };
      }
      // The pinned IPFS body wraps the disclosure map under `disclosure` and carries NO legalBasis today
      // (IpfsDocumentService::canonicalPayload). If a body ever carries one, it must agree with the signed one.
      const disclosure = asObject(asObject(body)["disclosure"]);
      let computed: string;
      try {
        if (basis !== undefined) {
          const bodyBasis = asObject(body)["legalBasis"];
          if (bodyBasis !== undefined && canonicalize(bodyBasis) !== canonicalize(basis)) {
            return { status: "fail", detail: "carries a legalBasis that differs from the signed one" };
          }
          computed = disclosureHashOf({ disclosure, legalBasis: basis });
        } else {
          computed = disclosureHashOf(disclosure);
        }
      } catch (err) {
        return { status: "fail", detail: `or the legalBasis cannot be canonicalized (${errorMessage(err)}), so the copy cannot be checked` };
      }
      return computed === disclosureHash
        ? { status: "pass", detail: `matches the signed disclosureHash ${disclosureHash}` }
        : { status: "fail", detail: `hashes to ${computed}, not the signed disclosureHash ${disclosureHash}` };
    };
    const read = await readPinnedFile(cid, gateways, this.opts.fetch ?? globalThis.fetch, this.timeoutMs(), judge, (v) => v.status === "pass");
    if (!read.delivered) {
      const tried = read.attempts.map((a) => `${a.gateway} (${a.failure})`).join("; ");
      notes.push(
        `disclosureCopy UNAVAILABLE: no IPFS gateway delivered the file of CID ${cid}: ${tried}. This is NOT a hash mismatch.`,
      );
      return "unavailable";
    }
    session.disclosureGateway = read.gateway;
    if (read.verdict.status === "pass") {
      notes.push(`Disclosure copy verified${label}: the IPFS document served by ${read.gateway} ${read.verdict.detail}.`);
      return "pass";
    }
    notes.push(
      `disclosureCopy FAILED${label}: the IPFS document of CID ${cid}, served by ${read.gateway} and re-encoding to that ` +
        `CID, ${read.verdict.detail}.`,
    );
    return "fail";
  }

  /**
   * OPT-IN (rpcUrl): is the document CID anchored? One eth_call `rootOf(keccak256(cid))`: lane 3 (a consent
   * document, untagged) passes, an empty record is not yet anchored (unavailable), a record in another lane or tagged fails.
   */
  private async verifyDocumentAnchor(r: Record<string, unknown>, notes: string[], session: ChainSession): Promise<CheckStatus> {
    const rpcUrl = this.opts.rpcUrl;
    if (!rpcUrl) {
      notes.push("documentAnchor skipped: pass an rpcUrl to check the on-chain document anchor.");
      return "skipped";
    }
    const consent = asObject(asObject(r["credentialSubject"])["consent"]);
    const cid = asString(asObject(consent["document"])["ipfsCid"]);
    if (!cid) {
      notes.push("documentAnchor skipped: the receipt carries no document.ipfsCid to look up on-chain.");
      return "skipped";
    }
    const chainId = this.chainId();
    const target = this.registryToRead(session);
    if (!target.ok) {
      notes.push(`documentAnchor UNAVAILABLE: ${target.reason} Nothing was read on chain.`);
      return "unavailable";
    }

    const call = await this.rpc(rpcUrl, "eth_call", [{ to: target.address, data: ROOT_OF_SELECTOR + stripHex(keccak256Hex(cid)) }, "latest"], session);
    const rec = call.ok ? decodeRootRecord(call.result) : null;
    if (!rec) {
      notes.push(
        `documentAnchor UNAVAILABLE: ${call.ok ? "the registry answered rootOf with an unreadable record" : call.reason}. ` +
          "This is NOT a missing anchor.",
      );
      return "unavailable";
    }
    // No record is not a contradiction: a document is published first and anchored asynchronously.
    if (rec.lane === 0) {
      notes.push(
        `documentAnchor UNAVAILABLE: CID ${cid} is not anchored yet on chainId ${String(chainId)}. ` +
          "A document is anchored after it is published, so an absent record is not a contradiction.",
      );
      return "unavailable";
    }
    if (rec.lane !== DOCUMENT_LANE || !/^0x0{64}$/.test(rec.tag)) {
      const as = rec.lane === DOCUMENT_LANE ? "a tagged document, which a consent document never is" : ROOT_LANES[rec.lane] ?? `a root of lane ${String(rec.lane)}`;
      notes.push(
        `documentAnchor FAILED: keccak256 of CID ${cid} is anchored on chainId ${String(chainId)} as ${as}, not as a ` +
          "consent document.",
      );
      return "fail";
    }
    session.documentRecord = { anchoredAt: rec.anchoredAt, anchoredBlock: rec.anchoredBlock };
    notes.push(
      `Document anchor FOUND on chainId ${String(chainId)}: CID ${cid} was anchored at ${String(rec.anchoredAt)} in block ` +
        `${String(rec.anchoredBlock)}. This proves the DOCUMENT existed, NOT that any consent was given.`,
    );
    return "pass";
  }

  /**
   * OPT-IN (rpcUrl), BUNDLE ONLY: eth_call registry(consentRef) for each cell's consentRef. The record is tied to
   * this receipt only through the Merkle root, which is trusted only once the passkey assertion is bound to it.
   * A withdrawn cell (state 2) is never a pass: the consent is no longer in force, however authentic.
   * TRAP: the ref list is signed by no one, so a file can drop a withdrawn ref. Every accepted cell the receipt lists
   * counts, and one with no ref is unreadable: a floor, since the items are not proven exhaustive either.
   */
  private async verifyConsentAnchor(
    refs: string[],
    merkleRoot: string,
    untrusted: string | null,
    expected: { cells: number; countAnchoredRefs: boolean },
    notes: string[],
    session: ChainSession,
  ): Promise<CheckStatus> {
    const rpcUrl = this.opts.rpcUrl;
    if (!rpcUrl) {
      notes.push("consentAnchor skipped: pass an rpcUrl to read the consent's on-chain record.");
      return "skipped";
    }
    if (refs.length === 0) {
      notes.push("consentAnchor skipped: the bundle carries no consentRef to read on chain.");
      return "skipped";
    }
    if (untrusted !== null) {
      notes.push(untrusted);
      return "skipped";
    }
    const chainId = this.chainId();
    const target = this.registryToRead(session);
    if (!target.ok) {
      notes.push(`consentAnchor UNAVAILABLE: ${target.reason}`);
      return "unavailable";
    }

    const root = stripHex(merkleRoot).toLowerCase();
    const records: ConsentAnchorRecord[] = [];
    let cells = Math.max(refs.length, expected.cells);
    let active = 0;
    let withdrawn = 0;
    let pending = 0;
    let unread = cells - refs.length;
    const foreign: string[] = [];
    for (const ref of refs) {
      const call = await this.rpc(rpcUrl, "eth_call", [{ to: target.address, data: REGISTRY_SELECTOR + stripHex(ref) }, "latest"], session);
      const rec = call.ok ? decodeAnchorRecord(call.result) : null;
      const revoked = rec !== null && (rec.state === 2 || rec.revokedAt > 0);
      // An anchoredAt with neither state Active nor Revoked is a garbage record, not a pending anchor.
      if (!rec || (rec.anchoredAt > 0 && !revoked && rec.state !== 1)) {
        unread++;
      } else if (rec.anchoredAt === 0) {
        pending++;
      } else if (stripHex(rec.merkleRoot).toLowerCase() !== root) {
        foreign.push(ref);
      } else {
        if (revoked) withdrawn++;
        else active++;
        records.push({ consentRef: ref, state: revoked ? "withdrawn" : "active", anchoredAt: rec.anchoredAt, revokedAt: rec.revokedAt, anchoredBlock: rec.anchoredBlock });
      }
    }
    if (records.length > 0) {
      session.consentRecords = records;
      const times = records.map((rec) => rec.anchoredAt);
      session.consentTiming = { earliest: Math.min(...times), latest: Math.max(...times) };
    }

    if (foreign.length > 0) {
      notes.push(
        `consentAnchor FAILED: the chain records consentRef ${foreign[0]!} under a different Merkle root than this ` +
          "bundle's, so the bundle's chain reference does not belong to this receipt.",
      );
      return "fail";
    }
    // How many refs the consent's own anchor wrote: the bundle's ref list and its items are signed by no one, the
    // AnchorBatch log of the trusted root is (chain.js readAnchoredRefCount). Unknown is never in force.
    let batchRefs: number | null = null;
    let countUnknown = false;
    if (expected.countAnchoredRefs && records.length > 0) {
      batchRefs = await this.readAnchorBatchCount(rpcUrl, target.address, "0x" + root, records.map((rec) => rec.anchoredBlock), session);
      if (batchRefs === null) countUnknown = true;
      else {
        // Only a ref the chain records under the trusted root fills a slot. TRAP: never subtract what the bundle
        // names: it can pad its list with refs that were never anchored.
        cells = Math.max(cells, batchRefs);
        unread = Math.max(0, cells - active - withdrawn - pending);
      }
    }
    const counts = `${String(cells)} cell(s): ${String(active)} active, ${String(withdrawn)} withdrawn, ` +
      `${String(pending)} not anchored yet, ${String(unread)} unreadable`;
    session.consentCounts = { cells, active, withdrawn, pending, unreadable: unread, ...(batchRefs !== null ? { anchorBatchRefs: batchRefs } : {}) };
    const blocks = [...new Set(records.map((rec) => rec.anchoredBlock))].join(", ");
    if (withdrawn > 0) {
      notes.push(
        `consentAnchor WITHDRAWN on chainId ${String(chainId)} (${counts}). The chain records the consent under ` +
          `this bundle's Merkle root, anchored in block ${blocks}, and records its withdrawal: it is authentic, but ` +
          "it is no longer in force. This is NOT a forgery.",
      );
      return "withdrawn";
    }
    if (active !== cells) {
      const unnamed = batchRefs !== null && batchRefs > refs.length
        ? ` The consent's anchor wrote ${String(batchRefs)} refs and the bundle names ${String(refs.length)}: an unnamed ` +
          "ref counts as unreadable."
        : cells > refs.length
          ? ` The bundle names a consentRef for ${String(refs.length)} of the receipt's ${String(cells)} accepted cells, and ` +
            "no one signs that list: an unnamed cell counts as unreadable."
          : "";
      notes.push(
        `consentAnchor UNAVAILABLE on chainId ${String(chainId)} (${counts}).${unnamed} Anchoring is asynchronous and an ` +
          "RPC can fail: this is NOT a contradiction.",
      );
      return "unavailable";
    }
    if (countUnknown) {
      notes.push(
        `consentAnchor UNAVAILABLE on chainId ${String(chainId)} (${counts}): how many refs the consent's anchor wrote ` +
          "could not be read (no single AnchorBatch log of this root at the one block its refs sit in), so the consent " +
          "is not shown in force. This is NOT a contradiction.",
      );
      return "unavailable";
    }
    notes.push(
      `Consent anchor FOUND on chainId ${String(chainId)} under this bundle's Merkle root (${counts}), anchored in ` +
        `block ${blocks}.`,
    );
    return "pass";
  }

  /**
   * The refCount of the ONE AnchorBatch log for `root` at the ONE block every matching ref sits in, read with a
   * single-block eth_getLogs on the registry read. Null (unknown) when the refs sit at more than one block, on a read
   * failure, or when anything but exactly one log of that root, from that address, at that block answers.
   * TRAP: never sum across blocks. One consent is one transaction; refs at two blocks mean a second batch.
   */
  private async readAnchorBatchCount(
    rpcUrl: string,
    address: string,
    root: string,
    blocks: number[],
    session: ChainSession,
  ): Promise<number | null> {
    const distinct = [...new Set(blocks)];
    if (distinct.length !== 1) return null;
    const block = distinct[0]!;
    if (!Number.isSafeInteger(block) || block < 0) return null;
    const at = "0x" + block.toString(16);
    const topic = root.toLowerCase();
    const want = address.toLowerCase();
    const call = await this.rpc(rpcUrl, "eth_getLogs", [{ address, topics: [ANCHOR_BATCH_TOPIC, topic], fromBlock: at, toBlock: at }], session);
    if (!call.ok || !Array.isArray(call.result)) return null;
    const ours = call.result.filter((entry): boolean => {
      const l = asObject(entry);
      const topics = asArray(l["topics"]);
      return (
        l["removed"] !== true &&
        asString(l["address"]).toLowerCase() === want &&
        asString(topics[0]).toLowerCase() === ANCHOR_BATCH_TOPIC &&
        asString(topics[1]).toLowerCase() === topic &&
        typeof l["blockNumber"] === "string" &&
        /^0x[0-9a-fA-F]+$/.test(l["blockNumber"]) &&
        parseInt(l["blockNumber"], 16) === block
      );
    });
    if (ours.length !== 1) return null;
    const data = stripHex(asString(asObject(ours[0])["data"])).toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(data)) return null;
    const count = Number.parseInt(data.slice(0, 64), 16);
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  }

  /** Resolve `slug` to the company did:web document (primitive). */
  async resolveCompanyDid(slug: string): Promise<DidDocument | null> {
    const host = this.opts.companyDidHost ?? DEFAULT_COMPANY_HOST;
    const did = `did:web:${host}:c:${slug}`;
    return this.resolveDid(did);
  }

  private chainId(): number {
    return this.opts.chainId ?? DEFAULT_CHAIN_ID;
  }

  /**
   * The registry the anchor checks read: the explicit registryAddress, else the chain's known one. A bundle that
   * names another registry or chain is refused, with no RPC: what it names can narrow the read, never redirect it.
   */
  private registryToRead(session: ChainSession): { ok: true; address: string } | { ok: false; reason: string } {
    const chainId = this.chainId();
    const address = this.opts.registryAddress ?? REGISTRY_BY_CHAIN[chainId];
    if (!address) {
      return { ok: false, reason: `no known registry for this chain (chainId ${String(chainId)}): pass its registryAddress.` };
    }
    const named = session.namedRegistry;
    if (named && (named.registry.toLowerCase() !== address.toLowerCase() || (named.chainId !== "" && named.chainId !== String(chainId)))) {
      session.registryRefused = true;
      return {
        ok: false,
        reason: `unknown registry: the bundle names the registry ${named.registry}${named.chainId ? ` on chainId ${named.chainId}` : ""}, ` +
          `which is not a known registry for chainId ${String(chainId)}. Nothing was read on chain.`,
      };
    }
    return { ok: true, address };
  }

  private timeoutMs(): number {
    return positiveInt(this.opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  /**
   * One JSON-RPC round trip, inside the verification's overall deadline. Every transport, HTTP or
   * JSON-RPC failure, and a passed deadline, is an outcome, never a throw.
   */
  private async rpc(rpcUrl: string, method: string, params: unknown[], session: ChainSession): Promise<RpcOutcome> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    session.deadline ??= Date.now() + positiveInt(this.opts.rpcDeadlineMs, DEFAULT_RPC_DEADLINE_MS);
    const remaining = session.deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, reason: "the overall RPC deadline passed before this call (rpcDeadlineMs)" };
    }
    try {
      const res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: timeoutSignal(Math.min(this.timeoutMs(), remaining)),
      });
      if (!res.ok) return { ok: false, reason: "the RPC call failed (transport error, HTTP error or timeout)" };
      const json = asObject(await res.json());
      if (json["error"] !== undefined) {
        const message = asString(asObject(json["error"])["message"]) || "no message";
        return { ok: false, reason: `the RPC refused the query (JSON-RPC error: ${message})` };
      }
      if (!("result" in json)) return { ok: false, reason: "the RPC answered without a result" };
      return { ok: true, result: json["result"] };
    } catch {
      return { ok: false, reason: "the RPC call failed (transport error, HTTP error or timeout)" };
    }
  }

  /**
   * The key that checks proof[0] ({@link companyKeyMethod}). A document that did not resolve is "unresolved"
   * (unavailable); a resolved one with no such method, or whose method carries no Ed25519 multikey, is "unlisted" (fail).
   */
  private async resolveCompanyKey(issuer: string, vmId: string): Promise<CompanyKey> {
    const doc = await this.resolveDid(issuer);
    if (!isPlainObject(doc)) return { kind: "unresolved" };
    const vm = companyKeyMethod(doc, issuer, vmId);
    if (!vm) return { kind: "unlisted" };
    try {
      return { kind: "key", key: decodeEd25519PublicKeyMultibase(vm.publicKeyMultibase), vmId: vm.id, doc };
    } catch {
      return { kind: "unlisted" };
    }
  }

  private async resolveDid(did: string): Promise<DidDocument | null> {
    const resolver = this.opts.resolver ?? this.defaultResolver();
    try {
      // A throwing (or rejecting) resolver is a resolution FAILURE, not a tamper:
      // null flows through to an "unavailable" check, never a "fail".
      return await resolver(did);
    } catch {
      return null;
    }
  }

  /** The default HTTPS resolver: did:web -> /c/{slug}/did.json; did:agreely -> /did/{did}. */
  private defaultResolver(): (did: string) => Promise<DidDocument | null> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    const citizenBase = (this.opts.citizenResolverBaseUrl ?? DEFAULT_CITIZEN_BASE).replace(/\/+$/, "");
    return async (did: string): Promise<DidDocument | null> => {
      let url: string;
      if (did.startsWith("did:web:")) {
        const parts = did.slice("did:web:".length).split(":");
        const host = decodeURIComponent(parts[0]!);
        const path = parts.slice(1).map((p) => decodeURIComponent(p));
        url = `https://${host}/${path.join("/")}/did.json`;
      } else {
        url = `${citizenBase}/did/${encodeURIComponent(did)}`;
      }
      try {
        const res = await fetchImpl(url, { signal: timeoutSignal(this.timeoutMs()) });
        if (!res.ok) return null;
        return (await res.json()) as DidDocument;
      } catch {
        return null;
      }
    };
  }
}

// --- helpers -----------------------------------------------------------------

function receiptType(r: Record<string, unknown>): ReceiptType {
  const types = asArray(r["type"]).map((t) => (typeof t === "string" ? t : ""));
  // Verbal first: a verbal receipt must never be read as a paper one, nor fall into
  // the citizen path (no passkey proof there reads as a false "failed").
  if (types.includes("VerbalConsentReceipt")) return "company_documented";
  if (asString(r["assuranceLevel"]) === "company_documented") return "company_documented";
  if (types.includes("CompanyAttestedConsentReceipt")) return "company_attested";
  if (asString(r["assuranceLevel"]) === "company_attested") return "company_attested";
  return "citizen";
}

/** The person's WebAuthn assertion is proof[1], as ConsentReceipt::build writes it, never another position. */
function findWebAuthnProof(proofs: unknown[]): Record<string, unknown> | null {
  const obj = asObject(proofs[1]);
  return asString(obj["type"]) === "WebAuthnAssertion" ? obj : null;
}

function exactStringMembers(o: unknown, keys: string[]): o is Record<string, string> {
  return (
    isPlainObject(o) &&
    Object.keys(o).length === keys.length &&
    keys.every((k) => Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === "string")
  );
}

const controlledBy = (vm: string, did: unknown): boolean => typeof did === "string" && did !== "" && vm.startsWith(did + "#");

/** proof[0] as the issuer writes it (verify-core.js issuerProofShaped): the company's eddsa-jcs-2022 proof. */
function issuerProofShaped(proof: unknown, issuer: unknown): proof is Record<string, string> {
  return (
    exactStringMembers(proof, ISSUER_PROOF_KEYS) &&
    proof["type"] === "DataIntegrityProof" &&
    proof["cryptosuite"] === "eddsa-jcs-2022" &&
    proof["proofPurpose"] === "assertionMethod" &&
    controlledBy(proof["verificationMethod"]!, issuer)
  );
}

/** proof[1] as ConsentReceipt::build writes it (verify-core.js citizenProofShaped): the person's WebAuthn assertion. */
function citizenProofShaped(proof: unknown, subject: unknown): proof is Record<string, string> {
  return (
    exactStringMembers(proof, CITIZEN_PROOF_KEYS) &&
    proof["type"] === "WebAuthnAssertion" &&
    controlledBy(proof["verificationMethod"]!, subject)
  );
}

/**
 * A passkey receipt carries exactly the company's proof then the person's, and the members the issuer copies from the
 * signed offer equal it (verify-core.js passkeyProofsShaped + proofMembersPinned). An offer without createdAt pins no
 * `created`, as offerWindowOf skips it.
 */
function passkeyProofFailure(r: Record<string, unknown>, offer: Record<string, unknown>): string | null {
  const proof = asArray(r["proof"]);
  const [issuerProof, citizenProof] = proof;
  const subject = asObject(r["credentialSubject"])["id"];
  if (proof.length !== 2 || !issuerProofShaped(issuerProof, r["issuer"]) || !citizenProofShaped(citizenProof, subject)) {
    return "the proof array is not the company's DataIntegrityProof then the person's WebAuthnAssertion, each with exactly the members the issuer writes";
  }
  if (typeof offer["createdAt"] === "string" && issuerProof["created"] !== offer["createdAt"]) {
    return "proof[0].created differs from the signed offer's createdAt";
  }
  if (citizenProof["nonce"] !== offer["nonce"]) return "proof[1].nonce differs from the signed offer's nonce";
  return null;
}

/** A recorded receipt carries exactly one company proof, and a v2 to v4 one was created at its recordedAt. */
function recordedProofFailure(r: Record<string, unknown>): string | null {
  const proof = asArray(r["proof"]);
  const issuerProof = proof[0];
  if (proof.length !== 1 || !issuerProofShaped(issuerProof, r["issuer"])) {
    return "the proof array is not exactly one company DataIntegrityProof with the members the issuer writes";
  }
  // TRAP: a v1 receipt (no receiptVersion) pins nothing until production is measured to hold created === grantedAt.
  if (!Object.prototype.hasOwnProperty.call(r, "receiptVersion")) return null;
  const recordedAt = asObject(asObject(r["credentialSubject"])["consent"])["recordedAt"];
  if (typeof recordedAt !== "string" || issuerProof["created"] !== recordedAt) {
    return "proof[0].created differs from the consent's recordedAt";
  }
  return null;
}

type CompanyKey = { kind: "unresolved" } | { kind: "unlisted" } | { kind: "key"; key: Uint8Array; vmId: string; doc: DidDocument };

/** The companyKeyRegistry check and, when a key was looked up, what the registry said. */
type CompanyKeyCheck = { status: CheckStatus; reading?: CompanyKeyReading };

/** The note and verdict when no key checks proof[0]: an unresolved document is inconclusive, an unlisted key fails. */
function companyKeyRefused(
  resolved: Exclude<CompanyKey, { kind: "key" }>,
  issuer: string,
  vm: string,
  notes: string[],
): CheckStatus {
  if (resolved.kind === "unresolved") {
    notes.push(
      `Company signature UNVERIFIABLE: could not resolve the issuer DID ${issuer} (key ${vm}) to an Ed25519 key ` +
        "(network/resolution failure or key not found). This is INCONCLUSIVE, NOT a signature mismatch.",
    );
    return "unavailable";
  }
  notes.push(
    `Company signature check FAILED: the issuer DID document of ${issuer} lists no Ed25519 key under assertionMethod ` +
      `for proof[0] (key ${vm}), so no key of the company may check this signature.`,
  );
  return "fail";
}

/**
 * The method that checks proof[0] (did.js issuerKeyFromDoc): the one whose id is `vmId`, an id under the issuer
 * (issuer + '#' + fragment), controlled by the issuer, referenced under the document's `assertionMethod` (full id, or
 * '#fragment', which resolves only as issuer + '#fragment') and carrying a multibase key. A fragment
 * of the issuer naming no method falls back to the document's SOLE assertionMethod method. Never the first method:
 * the document also lists the company's own `#recovery-1` key (capabilityInvocation), which Agreely never holds.
 */
function companyKeyMethod(
  doc: DidDocument,
  issuer: string,
  vmId: string,
): (DidVerificationMethod & { id: string; publicKeyMultibase: string }) | null {
  // A resolved document is outside input too: an entry that is not an object is skipped, never dereferenced.
  const methods = asArray(doc.verificationMethod).filter((m): m is DidVerificationMethod => isPlainObject(m));
  const assertion = asArray(doc["assertionMethod"]);
  // A method named under another DID never checks proof[0], even one the issuer controls.
  const asserts = (m: DidVerificationMethod): boolean =>
    typeof m.id === "string" &&
    issuer !== "" &&
    m.id.startsWith(issuer + "#") &&
    (assertion.includes(m.id) || assertion.includes(m.id.slice(issuer.length)));
  const named = methods.filter((m) => m.id === vmId);
  let vm: DidVerificationMethod | null = null;
  if (named.length === 1) {
    vm = named[0]!;
  } else if (named.length === 0 && issuer !== "" && vmId.startsWith(issuer + "#")) {
    const listed = methods.filter(asserts);
    vm = listed.length === 1 ? listed[0]! : null;
  }
  if (!vm || vm.controller !== issuer || !asserts(vm) || typeof vm.publicKeyMultibase !== "string") return null;
  return vm as DidVerificationMethod & { id: string; publicKeyMultibase: string };
}

/**
 * The passkey key the assertion is checked with (did.js citizenKeyFromDoc): the method the proof names, else the
 * first one carrying a COSE key. A method listed under capabilityDelegation and not under authentication is never
 * used; one listed under both is.
 */
function citizenKeyOf(doc: DidDocument, vmId: string): { cose: string; vmId: string } | null {
  const delegation = asArray(doc["capabilityDelegation"]);
  const auth = asArray(doc["authentication"]);
  const usable = (m: unknown): m is DidVerificationMethod => {
    if (!isPlainObject(m) || typeof m["publicKeyCose"] !== "string") return false;
    const id = m["id"];
    if (typeof id !== "string") return true;
    const frag = id.includes("#") ? "#" + id.split("#")[1]! : "";
    const listedIn = (refs: unknown[]): boolean => refs.includes(id) || (frag !== "" && refs.includes(frag));
    return !listedIn(delegation) || listedIn(auth);
  };
  const methods = asArray(doc.verificationMethod);
  const vm = methods.find((m) => usable(m) && m.id === vmId) ?? methods.find(usable);
  if (!vm || !usable(vm)) return null;
  return { cose: vm.publicKeyCose!, vmId: asString(vm.id) };
}

type CitizenKeyStanding = "confirmed" | "unlisted" | "outsideWindow" | "grantedAtUnreadable";

const CITIZEN_KEY_REFUSAL: Record<Exclude<CitizenKeyStanding, "confirmed">, string> = {
  unlisted:
    "the citizen's DID document does not list the key the assertion verified with under authentication (with the " +
    "same DID), so it is not proven to be the person's passkey.",
  outsideWindow:
    "the citizen's DID document lists the key the assertion verified with, but its validity window [validFrom, " +
    "validUntil) does not cover the receipt's grantedAt: the key did not belong to the person at that date.",
  grantedAtUnreadable:
    "the receipt's grantedAt is not a readable date, so no validity window of the person's key can cover it.",
};

/**
 * Where the key the assertion verified with stands in the citizen's own DID document (citizen-key.js
 * citizenKeyStandingFromDoc): confirmed only when a method of the same DID, listed under `authentication`, carries
 * exactly that COSE key and its window [validFrom, validUntil) covers grantedAt. The caller has already checked that
 * the document's id is the subject.
 */
function citizenKeyStanding(doc: DidDocument, subject: string, keyCose: string, grantedAt: string): CitizenKeyStanding {
  const auth = asArray(doc["authentication"]);
  const listed = (m: Record<string, unknown>): boolean => {
    if (typeof m["id"] !== "string") return false;
    const [base, frag] = m["id"].split("#");
    if (base !== subject || !frag) return false;
    return auth.includes(m["id"]) || auth.includes("#" + frag);
  };
  const key = normHex(keyCose);
  const held = asArray(doc.verificationMethod).filter(
    (m): m is Record<string, unknown> => isPlainObject(m) && listed(m) && key !== "" && normHex(m["publicKeyCose"]) === key,
  );
  if (held.length === 0) return "unlisted";
  const at = parseInstant(grantedAt);
  if (at === null) return "grantedAtUnreadable";
  const covers = (m: Record<string, unknown>): boolean => {
    const from = parseInstant(m["validFrom"]);
    if (from === null || from > at) return false;
    if (m["validUntil"] === null || m["validUntil"] === undefined) return true;
    const until = parseInstant(m["validUntil"]);
    return until !== null && at < until;
  };
  return held.some(covers) ? "confirmed" : "outsideWindow";
}

/** What the offer window says: the whole integrity note when it fails, else the clause the integrity note adds. */
type OfferWindow = { failure: string; clause: "" } | { failure: null; clause: string };

/**
 * A company-signed offer bounds when it could be accepted: createdAt <= grantedAt <= expiresAt, compared in whole
 * seconds. An offer without both dates gives no verdict here; a date that is present but unreadable fails.
 */
function offerWindowOf(r: Record<string, unknown>, offer: Record<string, unknown>): OfferWindow {
  const created = offer["createdAt"];
  const expires = offer["expiresAt"];
  if (created === undefined || created === null || expires === undefined || expires === null) {
    return { failure: null, clause: " The signed offer carries no createdAt and expiresAt pair, so its window was not checked." };
  }
  const grantedAt = asObject(asObject(r["credentialSubject"])["consent"])["grantedAt"];
  const [from, at, until] = [created, grantedAt, expires].map((v) => {
    const ms = parseInstant(v);
    return ms === null ? null : Math.floor(ms / 1000);
  });
  if (from == null || at == null || until == null) {
    return {
      failure:
        "Receipt integrity FAILED (offer-window-unreadable): the signed offer's createdAt or expiresAt, or the " +
        "receipt's grantedAt, is not a readable date.",
      clause: "",
    };
  }
  if (at < from || at > until) {
    return {
      failure:
        `Receipt integrity FAILED (granted-outside-offer-window): grantedAt ${asString(grantedAt)} lies outside the ` +
        `signed offer's window, from its createdAt ${asString(created)} to its expiresAt ${asString(expires)}.`,
      clause: "",
    };
  }
  return { failure: null, clause: " The receipt's grantedAt lies between the signed offer's createdAt and expiresAt." };
}

/** Epoch milliseconds of an instant matching INSTANT_PATTERN on a real calendar day, else null. */
function parseInstant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = INSTANT_PATTERN.exec(v);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", s = "0"] = [m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]];
  const fraction = m[7] ? Number((m[7].slice(1) + "00").slice(0, 3)) : 0;
  const zone = m[8] ?? "Z";
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offset = 0;
  if (zone !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offset = (zone.startsWith("-") ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return date.getTime() + ((hour * 60 + minute) * 60 + second) * 1000 + fraction - offset;
}

function normHex(h: unknown): string {
  return typeof h === "string" ? stripHex(h).toLowerCase() : "";
}

/** clientDataJSON is a webauthn.get whose challenge equals the proof's stated challenge. */
function clientDataChallengeMatches(clientDataJSON: Uint8Array, challengeHex: string): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON).toString("utf8")) as { type?: string; challenge?: string };
    if (parsed.type !== "webauthn.get" || typeof parsed.challenge !== "string") return false;
    return bytesEqual(base64urlDecode(parsed.challenge), hexDecode(challengeHex));
  } catch {
    return false;
  }
}

/**
 * Recompute the passkey challenge exactly as the server did (Commitment::challenge) and require it to
 * equal the challenge the passkey signed: keccak256(JCS({issuer, subject, requestId, action, grantedAt,
 * merkleRoot}) || nonce). Any change to those fields, or another consent's assertion, fails the equality.
 * Fails closed: a missing or non-string field is "unrecomputable", never a pass.
 */
function citizenChallengeBinds(
  r: Record<string, unknown>,
  offer: Record<string, unknown>,
  merkleRoot: string,
  statedChallenge: string,
): "ok" | "mismatch" | "unrecomputable" {
  const subject = asObject(r["credentialSubject"]);
  const consent = asObject(subject["consent"]);
  const nonce = offer["nonce"];
  if (typeof nonce !== "string" || nonce === "" || merkleRoot === "" || statedChallenge === "") return "unrecomputable";
  try {
    const context = canonicalize({
      issuer: r["issuer"],
      subject: subject["id"],
      requestId: consent["requestId"],
      action: consent["action"],
      grantedAt: consent["grantedAt"],
      merkleRoot,
    });
    const contextBytes = new TextEncoder().encode(context);
    const nonceBytes = hexDecode(nonce);
    const preimage = new Uint8Array(contextBytes.length + nonceBytes.length);
    preimage.set(contextBytes, 0);
    preimage.set(nonceBytes, contextBytes.length);
    const recomputed = Buffer.from(keccak256(preimage)).toString("hex");
    return recomputed === stripHex(statedChallenge).toLowerCase() ? "ok" : "mismatch";
  } catch {
    return "unrecomputable";
  }
}

/**
 * The receipt is consistent with the company-signed offer, EXHAUSTIVELY and deny-by-default
 * (verify-core.js receiptMatchesOffer + disclosureHashMatches + validFromMatchesGrantedAt), and its grantedAt lies
 * in the offer's window when `window` was judged. `reason` is integrityFailure(). One note either way.
 */
function checkReceiptIntegrity(reason: string | null, window: OfferWindow | null, notes: string[]): CheckStatus {
  if (reason !== null) {
    notes.push(`Receipt integrity FAILED: ${reason}.`);
    return "fail";
  }
  if (window?.failure) {
    notes.push(window.failure);
    return "fail";
  }
  notes.push(
    "Receipt integrity verified: every field the company-signed offer carries matches the receipt (issuer, " +
      "validUntil, the consent and its cells), the disclosureHash recomputes from the offer's disclosure (and " +
      "legalBasis), validFrom equals grantedAt, and the receipt carries no field outside the receipt format. " +
      "The receipt id is not covered by the offer." +
      (window?.clause ?? ""),
  );
  return "pass";
}

/**
 * A field the issuer never writes on a passkey receipt (ConsentReceipt::build): the file is not one Agreely issued, so
 * it is unreadable, never a tamper, as the web verifier's bundleShapeOf reads it.
 */
function passkeyFieldOutsideFormat(r: Record<string, unknown>): string | null {
  for (const k of Object.keys(r)) {
    if (!PASSKEY_RECEIPT_KEYS.has(k)) return `the passkey receipt carries a top-level field the issuer never writes (${k})`;
  }
  const subject = asObject(r["credentialSubject"]);
  for (const k of Object.keys(subject)) {
    if (k !== "id" && k !== "consent") return `the passkey receipt's credentialSubject carries a field the issuer never writes (${k})`;
  }
  for (const k of Object.keys(asObject(subject["consent"]))) {
    if (!ALLOWED_CONSENT_KEYS.has(k)) return `the passkey receipt's consent carries a field the issuer never writes (${k})`;
  }
  return null;
}

/**
 * The instant the company key signed (issuer.js signingInstantOf): a recorded receipt of version 2 to 4 was signed when
 * the organisation recorded it, a version 1 recorded receipt and a passkey receipt at grantedAt. A version 2 to 4
 * without recordedAt yields null.
 */
function signingInstantOf(r: Record<string, unknown>): string | null {
  const consent = asObject(asObject(r["credentialSubject"])["consent"]);
  const v = r["receiptVersion"];
  const at = v === "2" || v === "3" || v === "4" ? consent["recordedAt"] : consent["grantedAt"];
  return typeof at === "string" ? at : null;
}

function recordStrings(rec: KeyRecord): { validFrom: string; anchoredAt: string; retiredAt: string; voidedAt: string } {
  return {
    validFrom: rec.validFrom.toString(),
    anchoredAt: rec.anchoredAt.toString(),
    retiredAt: rec.retiredAt.toString(),
    voidedAt: rec.voidedAt.toString(),
  };
}

const CITIZEN_KEY_NOTES: Record<string, string> = {
  chainConfirmed: "the registry records the person's key in force at grantedAt, and the consent's anchor bounds that date",
  notInForce: "the registry records the person's key as NOT in force at grantedAt (not valid yet, or retired)",
  conflict: "the registry and the person's DID document disagree about the key",
  didRefused: "the person's DID document refuses the key",
  grantedAfterConsentAnchor: "grantedAt is later than the consent's own anchor allows, so the date is contradicted",
  recordedLate: "the registry recorded the key's window more than 72 hours after grantedAt",
  voided: "the registry records the person's key as voided",
  consentRecordedLate: "grantedAt falls more than 72 hours before the consent's earliest anchor",
  consentNotAnchored: "the key is in force at grantedAt, but no anchor of this consent bounds that date yet",
  didNotConsulted: "the key is in force at grantedAt, but its DID document standing was not read",
  notLinked: "the bundle carries no citizenKeySalt, so its key cannot be looked up on chain",
  pending: "the registry has no record of the key yet, and anchoring takes up to 72 hours after grantedAt",
  unreachable: "the registry could not be read",
  notRecorded: "the registry still has no record of the key 72 hours after grantedAt",
  unreadable: "the bundle's citizenKeySalt or the registry's answer cannot be read",
};

function citizenKeyNote(k: CitizenKeyReading): string {
  const head =
    k.colour === "green" ? "Citizen key confirmed on chain"
    : k.colour === "red" ? "citizenKeyChain FAILED"
    : k.withholds ? "citizenKeyChain UNAVAILABLE, and the person's key is withheld"
    : k.colour === "amber" ? "citizenKeyChain UNAVAILABLE"
    : "citizenKeyChain adds nothing";
  return `${head} (${k.chainState}): ${CITIZEN_KEY_NOTES[k.reason] ?? k.reason}.`;
}

const COMPANY_KEY_NOTES: Record<string, string> = {
  authentic: "was in force on its domain at the instant it signed",
  "key-not-authorised": "was NOT in force on its domain at the instant it signed",
  "signed-after-anchor": "signed later than the consent's own anchor allows, so the signing date is contradicted",
  voided: "has a window the registry records as voided",
  pending: "has no window on its domain in the registry yet",
  "recorded-late": "was recorded on its domain more than 72 hours after the instant it signed",
  "retired-issuer-dated": "has since been retired, and the instant it signed is the issuer's own date, which no anchor bounds",
  unknown: "has a window that cannot be judged at the instant it signed",
};

function companyKeyNote(k: CompanyKeyReading): string {
  const head =
    k.verdict === "authentic" ? "Company key confirmed on chain"
    : k.verdict === "key-not-authorised" || k.verdict === "signed-after-anchor" || k.verdict === "voided"
      ? "companyKeyRegistry FAILED"
      : "companyKeyRegistry UNAVAILABLE";
  const rotated = k.rotated === true ? ` The company has since rotated to the key ${k.currentKeyId ?? ""}.` : "";
  return `${head}: the key ${k.keyId} ${COMPANY_KEY_NOTES[k.verdict] ?? k.verdict} (${k.domain}).${rotated}`;
}

/** Accepted cells the receipt lists: one consentRef each. */
function acceptedCellCount(r: Record<string, unknown>): number {
  return asArray(asObject(asObject(r["credentialSubject"])["consent"])["items"]).length;
}

/** What the consent anchor read says about the consent being in force. Only a complete read says "active". */
function withdrawalOf(consentAnchor: CheckStatus, session: ChainSession): Pick<ReceiptVerification, "withdrawal" | "withdrawnAt"> {
  if (consentAnchor === "pass") return { withdrawal: "active" };
  if (consentAnchor !== "withdrawn") return { withdrawal: "not_checked" };
  const latest = Math.max(0, ...(session.consentRecords ?? []).filter((rec) => rec.state === "withdrawn").map((rec) => rec.revokedAt));
  return latest > 0 ? { withdrawal: "withdrawn", withdrawnAt: latest } : { withdrawal: "withdrawn" };
}

function integrityFailure(r: Record<string, unknown>, offer: Record<string, unknown>): string | null {
  if (!canonEqual(r["type"], PASSKEY_RECEIPT_TYPE)) return "the receipt type is not a passkey ConsentReceipt";
  if (!canonEqual(r["@context"], PASSKEY_RECEIPT_CONTEXT)) return "the receipt @context is not the consent receipt context";
  if (typeof r["id"] !== "string" || !r["id"].startsWith("urn:agreely:receipt:")) {
    return "the receipt id is not an urn:agreely:receipt identifier";
  }
  const consent = asObject(asObject(r["credentialSubject"])["consent"]);
  const offerConsent = asObject(offer["consent"]);
  if (r["issuer"] !== offer["issuer"]) return "the issuer differs from the signed offer's";
  if (r["validUntil"] !== (offer["validUntil"] || "")) return "validUntil differs from the signed offer's";
  if (consent["action"] !== offerConsent["action"]) return "the action differs from the signed offer's";
  if (consent["requestId"] !== (offer["requestId"] || "")) return "the requestId differs from the signed offer's";
  if (!canonEqual(consent["document"], offer["document"])) return "the document differs from the signed offer's";
  if (consent["disclosureHash"] !== offer["disclosureHash"]) return "the disclosureHash differs from the signed offer's";
  if (!itemsAreExactOfferItems(consent["items"], offerConsent["items"])) {
    return "an accepted cell is not an exact item of the signed offer";
  }
  if (consent["declinedItems"] !== undefined) {
    if (!itemsAreExactOfferItems(consent["declinedItems"], offerConsent["items"])) {
      return "a declined cell is not an exact item of the signed offer";
    }
    const accepted = new Set(asArray(consent["items"]).map(canonOrNull));
    if (asArray(consent["declinedItems"]).some((i) => accepted.has(canonOrNull(i)))) {
      return "a cell is both accepted and declined";
    }
  }
  if (consent["legalBasis"] !== undefined) {
    if (!canonEqual(consent["legalBasis"], offer["legalBasis"])) return "the legalBasis differs from the signed offer's";
    if (consent["disclosureVersion"] !== (offer["disclosureVersion"] || "")) {
      return "the disclosureVersion differs from the signed offer's";
    }
  } else if (offer["legalBasis"] !== undefined && offer["legalBasis"] !== null) {
    return "the signed offer carries a legalBasis the receipt dropped";
  }
  if (consent["minor"] !== undefined) {
    if (!canonEqual(consent["minor"], offer["minor"])) return "the minor block differs from the signed offer's";
  } else if (offer["minor"] !== undefined && offer["minor"] !== null) {
    return "the signed offer carries a minor block the receipt dropped";
  }
  if (!disclosureHashRecomputes(consent, offer)) {
    return "the disclosureHash does not recompute from the signed offer's disclosure";
  }
  if (typeof r["validFrom"] !== "string" || r["validFrom"] !== consent["grantedAt"]) {
    return "validFrom differs from grantedAt";
  }
  return passkeyProofFailure(r, offer);
}

/** sha256(JCS(preimage)) equals BOTH the receipt's and the offer's stated hash. v2 offer: {disclosure, legalBasis}. */
function disclosureHashRecomputes(consent: Record<string, unknown>, offer: Record<string, unknown>): boolean {
  const stated = consent["disclosureHash"];
  if (typeof stated !== "string" || offer["disclosure"] === undefined) return false;
  const basis = offer["legalBasis"];
  const preimage = basis !== undefined && basis !== null ? { disclosure: offer["disclosure"], legalBasis: basis } : offer["disclosure"];
  let computed: string;
  try {
    computed = disclosureHashOf(preimage);
  } catch {
    return false;
  }
  return stated.toLowerCase() === computed && String(offer["disclosureHash"]).toLowerCase() === computed;
}

function itemsAreExactOfferItems(receiptItems: unknown, offerItems: unknown): boolean {
  if (!Array.isArray(receiptItems) || !Array.isArray(offerItems) || receiptItems.length === 0) return false;
  const offered = new Set(offerItems.map(canonOrNull));
  return receiptItems.every((i) => {
    const c = canonOrNull(i);
    return c !== null && offered.has(c);
  });
}

function canonOrNull(v: unknown): string | null {
  try {
    return canonicalize(v);
  } catch {
    return null;
  }
}

function canonEqual(a: unknown, b: unknown): boolean {
  const ca = canonOrNull(a);
  return ca !== null && ca === canonOrNull(b);
}

/** Every accepted cell's consentRef (consentRefs), else the legacy single consentRef. De-duped, bytes32 only. */
function collectConsentRefs(bundle: Record<string, unknown>): string[] {
  const isRef = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
  let refs = asArray(bundle["consentRefs"]).filter(isRef);
  if (refs.length === 0 && isRef(bundle["consentRef"])) refs = [bundle["consentRef"]];
  return [...new Set(refs.map((ref) => ref.toLowerCase()))].slice(0, MAX_CONSENT_REFS);
}

/**
 * Decode registry(bytes32): merkleRoot, anchoredAt, revokedAt, state, anchoredBlock. A prefix read: trailing data
 * is ignored, a shorter answer or a word out of its type's range is null, so it reads as unreadable, never as a
 * contradiction.
 */
export function decodeAnchorRecord(
  result: unknown,
): { state: number; merkleRoot: string; anchoredAt: number; revokedAt: number; anchoredBlock: number } | null {
  const h = stripHex(asString(result)).toLowerCase();
  if (!/^[0-9a-f]{320}/.test(h)) return null;
  const word = (i: number): string => h.slice(i * 64, i * 64 + 64);
  const anchoredAt = uint64Word(word(1));
  const revokedAt = uint64Word(word(2));
  const anchoredBlock = uint64Word(word(4));
  if (!/^0{62}[0-9a-f]{2}$/.test(word(3)) || anchoredAt === null || revokedAt === null || anchoredBlock === null) return null;
  return { state: parseInt(word(3), 16), merkleRoot: "0x" + word(0), anchoredAt, revokedAt, anchoredBlock };
}

/**
 * Decode rootOf(bytes32): tag, anchoredAt, anchoredBlock, lane. Null on anything else, and on a record that
 * contradicts itself (a lane without an anchor time, or an anchor time without a lane).
 */
export function decodeRootRecord(
  result: unknown,
): { tag: string; anchoredAt: number; anchoredBlock: number; lane: number } | null {
  const h = stripHex(asString(result)).toLowerCase();
  if (!/^[0-9a-f]{256}/.test(h)) return null;
  const word = (i: number): string => h.slice(i * 64, i * 64 + 64);
  const anchoredAt = uint64Word(word(1));
  const anchoredBlock = uint64Word(word(2));
  if (anchoredAt === null || anchoredBlock === null || !/^0{62}[0-9a-f]{2}$/.test(word(3))) return null;
  const lane = parseInt(word(3), 16);
  if ((lane === 0) !== (anchoredAt === 0)) return null;
  return { tag: "0x" + word(0), anchoredAt, anchoredBlock, lane };
}

/** A uint64 ABI word as a safe integer, null when it is not one. */
function uint64Word(w: string): number | null {
  if (!/^0{48}[0-9a-f]{16}$/.test(w)) return null;
  const n = parseInt(w, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The registry a bundle names: its issuer's key delegation is bound to one chain and one registry. Null when
 * the bundle names none. The delegation is not verified here, so this is only ever used to refuse a read.
 */
function namedRegistryOf(bundle: Record<string, unknown>): NamedRegistry | null {
  const body = asObject(asObject(asObject(asObject(bundle["didDocuments"])["issuer"])["delegation"])["body"]);
  const registry = asString(body["registry"]);
  if (registry === "") return null;
  const chainId = body["chainId"];
  return { registry, chainId: typeof chainId === "string" || typeof chainId === "number" ? String(chainId) : "" };
}

/** The anchor records, consent tally and registry refusal a verification read, for its result: absent when none. */
function anchorRecords(
  session: ChainSession,
): Pick<ReceiptVerification, "documentAnchorRecord" | "consentAnchorRecords" | "consentAnchorCounts" | "registryRefused" | "disclosureGateway"> {
  return {
    ...(session.documentRecord ? { documentAnchorRecord: session.documentRecord } : {}),
    ...(session.consentRecords ? { consentAnchorRecords: session.consentRecords } : {}),
    ...(session.consentCounts ? { consentAnchorCounts: session.consentCounts } : {}),
    ...(session.registryRefused ? { registryRefused: true } : {}),
    ...(session.disclosureGateway !== undefined ? { disclosureGateway: session.disclosureGateway } : {}),
  };
}

/**
 * Is the human-readable cell label (category/purpose) of a RECORDED receipt bound? The labels sit
 * INSIDE the Ed25519-signed body, so this tracks companySignature.
 */
function assessRecordedCellLabels(companySignature: CheckStatus, notes: string[]): CheckStatus {
  if (companySignature === "pass") {
    notes.push(
      "Cell labels bound: the category/purpose labels sit inside the company-signed body, so the verified signature " +
        "covers them. Mutating any item label breaks it.",
    );
    return "pass";
  }
  if (companySignature === "unavailable") {
    notes.push(
      "Cell-label binding UNVERIFIABLE: the issuer DID could not be resolved, so the company signature that binds the " +
        "category/purpose labels could not be checked.",
    );
    return "unavailable";
  }
  notes.push(
    "Cell labels UNBOUND: the company signature over the body that carries the category/purpose labels did not verify, " +
      "so the displayed labels are unproven (possibly tampered).",
  );
  return "fail";
}

/** Why a bundle-shaped input is not a version "1" bundle. */
function bundleShapeFailure(o: Record<string, unknown>): string {
  if (o["version"] !== BUNDLE_VERSION) return `the bundle version is not the string "${BUNDLE_VERSION}"`;
  if (!isPlainObject(o["receipt"])) return "the bundle's receipt is missing or not an object";
  return "the bundle's signedOffer is not an object";
}

/** Iterative, so a hostile depth cannot overflow the stack while it is measured. */
function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth > max) return true;
    for (const child of Object.values(v as Record<string, unknown>)) stack.push([child, depth + 1]);
  }
  return false;
}

/** Every check "skipped": none ran. receiptType is read from the receipt's own type, a best guess. */
function malformedResult(input: "bundle" | "receipt", type: ReceiptType, reason: string): ReceiptVerification {
  return {
    input,
    receiptType: type,
    companySignature: "skipped",
    receiptIntegrity: "skipped",
    citizenAssertion: "skipped",
    disclosureCopy: "skipped",
    documentAnchor: "skipped",
    consentAnchor: "skipped",
    cellLabelBinding: "skipped",
    overall: "malformed",
    withdrawal: "not_checked",
    notes: [
      `MALFORMED: ${reason}. No check ran: this is a file this verifier cannot read, not evidence that it was ` +
        "altered. A file Agreely issued is a version \"1\" bundle or a receipt object.",
    ],
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function disclosureNotRequestedNote(): string {
  return "disclosureCopy skipped: not requested. It fetches the document from a third-party IPFS gateway: pass " +
    "verifyDisclosure: true to run it.";
}

/** "0x" + sha256(JCS(preimage)): the disclosureHash formula the app seals (ConsentRequestService). */
function disclosureHashOf(preimage: unknown): string {
  return "0x" + createHash("sha256").update(canonicalize(preimage)).digest("hex");
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function positiveInt(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

function stripHex(h: string): string {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function asObject(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
