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
// a non-object receipt or offer, a number, nesting past MAX_INPUT_DEPTH) reads "malformed",
// and verify() resolves on every input, a deep one included.

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
import type {
  CheckStatus,
  DidDocument,
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
const DEFAULT_IPFS_GATEWAY = "https://gateway.lighthouse.storage/ipfs/";
// The LIVE Base mainnet AgreelyRegistry, deployed at block 48889369 (the 2026-07-19
// redeploy that carries the DID-tagged anchor events). EIP-55 checksummed.
//
// KEEP THIS IN SYNC WITH THE DEPLOYMENT. It is pinned BY HAND here (the SDK has no
// config to read), and the app resolves its own address from config/anchor-network.json,
// so a redeploy does NOT propagate here on its own. A stale address is SILENT and WORSE
// than a missing one: the superseded contract still exists on chain and still answers,
// it just holds no anchors, so every anchor check would contradict a valid receipt.
// The predecessor 0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B did exactly that in v0.2.0.
// verifyReceipt.test.ts pins this value so a silent edit fails a test.
//
// Setting it back to null reports the on-chain checks as "skipped" for mainnet (never a
// false result), which is the correct fallback if it is ever unknown.
const MAINNET_REGISTRY_ADDRESS: string | null = "0x23577fafFa306375028D33a559D0F95Ced9424DB";
const MAINNET_DEPLOY_BLOCK = 48889369;
// Base mainnet (chainId 8453) is the default. Base Sepolia (84532) remains available as an
// explicit opt-in for integrators testing against the testnet registry (pass chainId 84532).
const DEFAULT_CHAIN_ID = 8453;
const REGISTRY_BY_CHAIN: Record<number, string | null> = {
  8453: MAINNET_REGISTRY_ADDRESS, // Base mainnet (default)
  84532: "0x3532a9DfF3C910152543afCa49De7c66113C5312", // Base Sepolia (optional testing)
};
const DEPLOY_BLOCK_BY_CHAIN: Record<number, number> = { 8453: MAINNET_DEPLOY_BLOCK, 84532: 43698609 };
// `registry(bytes32)` answers the deployed `struct Anchor` as four words whose ORDER changed
// between deployments: Sepolia still runs the pre-repack layout (chain.js carries the history).
const LEGACY_LAYOUT_CHAINS = new Set([84532]);
// keccak256("IdentityAnchored(bytes32,uint64)"), the document CID is anchored via
// anchorIdentity(commitment = keccak256(utf8(cid))). Emit-only: there is no view to read it,
// so the document anchor is a log query, bounded and best-effort.
const IDENTITY_ANCHORED_TOPIC = keccak256Hex("IdentityAnchored(bytes32,uint64)");
const REGISTRY_SELECTOR = keccak256Hex("registry(bytes32)").slice(0, 10);
const DEFAULT_LOG_RANGE_LIMIT = 10_000;
const DEFAULT_MAX_LOG_QUERIES = 10;
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
type RpcClock = { deadline: number | null };

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
    const clock: RpcClock = { deadline: null };
    const type = receiptType(r);
    const notes: string[] = [];
    if (bundle) {
      notes.push(
        "Read as a verification bundle. Keys are resolved from the issuer and citizen DIDs (or your resolver), " +
          "never taken from the bundle's own didDocuments, which anyone can write.",
      );
    }

    if (type !== "citizen") {
      return this.verifyRecorded(r, type, bundle !== null, notes, clock);
    }
    if (!bundle) return this.verifyBarePasskey(r, notes, clock);
    const offer = bundle["signedOffer"];
    const merkleRoot = bundle["merkleRoot"];
    if (!isPlainObject(offer) || Object.keys(offer).length === 0) {
      throw new MalformedInput("the bundle carries a passkey receipt but no signedOffer object");
    }
    if (typeof merkleRoot !== "string" || merkleRoot === "") {
      throw new MalformedInput("the bundle carries a passkey receipt but no merkleRoot string");
    }
    return this.verifyPasskeyBundle(r, bundle, offer, merkleRoot, notes, clock);
  }

  /** A paper (company_attested) or telephone (company_documented) receipt: the company signed the body itself. */
  private async verifyRecorded(
    r: Record<string, unknown>,
    type: "company_attested" | "company_documented",
    fromBundle: boolean,
    notes: string[],
    clock: RpcClock,
  ): Promise<ReceiptVerification> {
    const companySignature = await this.verifyCompanySignature(r, notes, type);
    notes.push(
      type === "company_attested"
        ? "A company-attested receipt carries no citizen passkey assertion, so citizenAssertion is not applicable."
        : "A verbal (company-documented) receipt carries no citizen passkey assertion, so citizenAssertion is not applicable.",
    );
    // The signature is taken over the receipt body itself, so it IS the integrity check.
    const receiptIntegrity = companySignature;
    const cellLabelBinding = assessRecordedCellLabels(companySignature, notes);
    const disclosureCopy = await this.verifyRecordedDisclosureCopy(r, notes);
    const documentAnchor = await this.verifyDocumentAnchor(r, notes, clock);
    notes.push("consentAnchor skipped: a recorded receipt carries no consentRef to read on chain.");
    const consentAnchor: CheckStatus = "skipped";

    let overall: ReceiptVerification["overall"];
    if (companySignature === "fail" || disclosureCopy === "fail" || documentAnchor === "fail") overall = "failed";
    else if (companySignature === "unavailable") overall = "unavailable";
    // A telephone receipt is the organisation's word, authenticated: never more than partial.
    else overall = type === "company_attested" ? "verified" : "partial";

    return {
      input: fromBundle ? "bundle" : "receipt",
      receiptType: type,
      companySignature,
      receiptIntegrity,
      citizenAssertion: "unsupported",
      disclosureCopy,
      documentAnchor,
      consentAnchor,
      cellLabelBinding,
      overall,
      notes,
    };
  }

  /** A passkey receipt WITHOUT its signed offer and Merkle root: nothing binds the assertion to the content. */
  private async verifyBarePasskey(r: Record<string, unknown>, notes: string[], clock: RpcClock): Promise<ReceiptVerification> {
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
    const documentAnchor = await this.verifyDocumentAnchor(r, notes, clock);
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
    clock: RpcClock,
  ): Promise<ReceiptVerification> {
    const companySignature = await this.verifyOfferSignature(r, offer, notes);
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

    const disclosureCopy = await this.verifyOfferDisclosureCopy(offer, companySignature, notes);
    const documentAnchor = await this.verifyDocumentAnchor(r, notes, clock);
    const consentAnchor = await this.verifyConsentAnchor(bundle, merkleRoot, citizenAssertion, notes, clock);

    let overall: ReceiptVerification["overall"];
    const checks = [companySignature, receiptIntegrity, citizenAssertion, disclosureCopy, documentAnchor, consentAnchor];
    if (checks.includes("fail")) overall = "failed";
    else if (companySignature === "pass" && receiptIntegrity === "pass" && citizenAssertion === "pass") overall = "verified";
    else overall = "unavailable";

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
      notes,
    };
  }

  /** RECORDED: verify the Ed25519 proof over the canonical receipt body. */
  private async verifyCompanySignature(
    r: Record<string, unknown>,
    notes: string[],
    type: "company_attested" | "company_documented",
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

    const key = await this.resolveEd25519Key(issuer, vm);
    if (!key) {
      notes.push(
        `Company signature UNVERIFIABLE: could not resolve the issuer DID ${issuer} (key ${vm}) to an Ed25519 key ` +
          "(network/resolution failure or key not found). This is INCONCLUSIVE, NOT a signature mismatch.",
      );
      return "unavailable";
    }

    if (verifyEd25519(key, canonical, signature)) {
      notes.push(`Company signature verified against issuer DID ${issuer} (key ${vm}).`);
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
      `Company signature check FAILED against issuer DID ${issuer} (key ${vm}): the canonical receipt body does not ` +
        "match the signature. The receipt was altered after signing or the wrong key was resolved.",
    );
    return "fail";
  }

  /** PASSKEY BUNDLE: proof[0] is the company's Ed25519 signature over JCS(signedOffer). */
  private async verifyOfferSignature(
    r: Record<string, unknown>,
    offer: Record<string, unknown>,
    notes: string[],
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
    const key = await this.resolveEd25519Key(issuer, vm);
    if (!key) {
      notes.push(
        `Company signature UNVERIFIABLE: could not resolve the issuer DID ${issuer} (key ${vm}) to an Ed25519 key ` +
          "(network/resolution failure or key not found). This is INCONCLUSIVE, NOT a signature mismatch.",
      );
      return "unavailable";
    }
    if (verifyEd25519(key, canonical, signature)) {
      notes.push(`Company signature over the signed offer verified against issuer DID ${issuer} (key ${vm}).`);
      return "pass";
    }
    notes.push(
      `Company signature check FAILED against issuer DID ${issuer} (key ${vm}): the signed offer does not match the ` +
        "signature. The offer was altered after signing or the wrong key was resolved.",
    );
    return "fail";
  }

  /** The WebAuthn signature over authenticatorData || sha256(clientDataJSON), and clientDataJSON's own challenge. */
  private async verifyPasskeySignature(
    r: Record<string, unknown>,
    notes: string[],
  ): Promise<{ status: CheckStatus; vm: string; challenge: string; standing?: CitizenKeyStanding }> {
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
    return { status: "pass", vm: key.vmId, challenge, standing: citizenKeyStanding(doc, citizenDid, coseHex, grantedAt) };
  }

  /**
   * RECORDED: fetch the IPFS document body and match its disclosure to disclosureHash. On a recorded
   * receipt the disclosureHash and a v2 legalBasis sit inside the company-signed body. v2 hashes
   * {disclosure, legalBasis}; v1 (or absent) hashes the disclosure map alone.
   */
  private async verifyRecordedDisclosureCopy(r: Record<string, unknown>, notes: string[]): Promise<CheckStatus> {
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
    return this.compareDisclosureCopy(cid, disclosureHash, version === "2" ? receiptBasis : undefined, notes);
  }

  /** PASSKEY BUNDLE: the copy is compared with the SIGNED offer's disclosureHash and legalBasis, never the receipt's. */
  private async verifyOfferDisclosureCopy(
    offer: Record<string, unknown>,
    companySignature: CheckStatus,
    notes: string[],
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
    return this.compareDisclosureCopy(cid, disclosureHash, basis === undefined || basis === null ? undefined : basis, notes);
  }

  /** Fetch the IPFS body and compare sha256(JCS(preimage)) with `disclosureHash`. `basis` set = the v2 preimage. */
  private async compareDisclosureCopy(
    cid: string,
    disclosureHash: string,
    basis: unknown,
    notes: string[],
  ): Promise<CheckStatus> {
    const gateway = this.opts.ipfsGateway ?? ((c: string) => DEFAULT_IPFS_GATEWAY + c);
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    let body: unknown;
    try {
      const res = await fetchImpl(gateway(cid), { signal: timeoutSignal(this.timeoutMs()) });
      if (!res.ok) {
        notes.push(
          `disclosureCopy UNAVAILABLE: the IPFS gateway answered HTTP ${String(res.status)} for CID ${cid}. This is NOT a hash mismatch.`,
        );
        return "unavailable";
      }
      body = await res.json();
    } catch {
      notes.push(
        `disclosureCopy UNAVAILABLE: fetching the IPFS body for CID ${cid} failed or timed out. This is NOT a hash mismatch.`,
      );
      return "unavailable";
    }

    // The pinned IPFS body wraps the disclosure map under `disclosure` and carries NO legalBasis today
    // (IpfsDocumentService::canonicalPayload). If a body ever carries one, it must agree with the signed one.
    const disclosure = asObject(asObject(body)["disclosure"]);
    let computed: string;
    try {
      if (basis !== undefined) {
        const bodyBasis = asObject(body)["legalBasis"];
        if (bodyBasis !== undefined && canonicalize(bodyBasis) !== canonicalize(basis)) {
          notes.push(
            "disclosureCopy FAILED (disclosureVersion 2): the IPFS document body carries a legalBasis that differs from the signed one.",
          );
          return "fail";
        }
        computed = disclosureHashOf({ disclosure, legalBasis: basis });
      } else {
        computed = disclosureHashOf(disclosure);
      }
    } catch (err) {
      notes.push(
        `disclosureCopy FAILED: the IPFS document body or the legalBasis cannot be canonicalized (${errorMessage(err)}), so the copy cannot be checked.`,
      );
      return "fail";
    }
    const label = basis !== undefined ? " (disclosureVersion 2: {disclosure, legalBasis})" : "";
    if (computed === disclosureHash) {
      notes.push(`Disclosure copy verified${label}: the IPFS document body matches the signed disclosureHash ${disclosureHash}.`);
      return "pass";
    }
    notes.push(
      `disclosureCopy FAILED${label}: the IPFS document body hashes to ${computed}, not the signed disclosureHash ${disclosureHash}.`,
    );
    return "fail";
  }

  /**
   * OPT-IN (rpcUrl): is the document CID anchored (IdentityAnchored)? The event is emit-only, so this is
   * a log query from the registry's deploy block, paged under a provider's range limit. "fail" only when
   * the chain answered for EVERY block of that range; any refusal, error or budget exhaustion is "unavailable".
   */
  private async verifyDocumentAnchor(r: Record<string, unknown>, notes: string[], clock: RpcClock): Promise<CheckStatus> {
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
    const registry = this.registry();
    if (!registry) {
      notes.push(`documentAnchor skipped: no AgreelyRegistry address is known for chainId ${String(chainId)}.`);
      return "skipped";
    }

    const head = await this.rpc(rpcUrl, "eth_blockNumber", [], clock);
    const latest = head.ok ? parseQuantity(head.result) : null;
    if (!head.ok || latest === null) {
      notes.push(
        `documentAnchor UNAVAILABLE: ${head.ok ? "the RPC answered an unreadable block number" : head.reason}. This is NOT a missing anchor.`,
      );
      return "unavailable";
    }
    const from = Math.min(this.opts.registryDeployBlock ?? DEPLOY_BLOCK_BY_CHAIN[chainId] ?? 0, latest);
    const topics = [IDENTITY_ANCHORED_TOPIC, keccak256Hex(cid)];
    const found = `Document anchor FOUND on chainId ${String(chainId)}: CID ${cid} existed at anchor time. ` +
      "This proves the DOCUMENT existed, NOT that any consent was given.";
    const absent = `documentAnchor FAILED: the chain answered for every block from ${String(from)} to ${String(latest)} ` +
      `and holds no anchor for CID ${cid} on chainId ${String(chainId)}.`;

    // One full-range query first: a provider without a range limit answers it outright.
    const full = await this.getLogs(rpcUrl, registry, from, latest, topics, clock);
    if (full.ok) {
      if (!Array.isArray(full.result)) {
        notes.push("documentAnchor UNAVAILABLE: the RPC answered the log query with something other than a list. This is NOT a missing anchor.");
        return "unavailable";
      }
      notes.push(full.result.length > 0 ? found : absent);
      return full.result.length > 0 ? "pass" : "fail";
    }

    // Refused (range limit, archive token): page backwards from the head, newest first.
    const range = positiveInt(this.opts.logRangeLimit, DEFAULT_LOG_RANGE_LIMIT);
    const budget = positiveInt(this.opts.maxLogQueries, DEFAULT_MAX_LOG_QUERIES);
    let hi = latest;
    for (let q = 0; q < budget && hi >= from; q++) {
      const lo = Math.max(from, hi - range + 1);
      const page = await this.getLogs(rpcUrl, registry, lo, hi, topics, clock);
      if (!page.ok || !Array.isArray(page.result)) {
        notes.push(
          `documentAnchor UNAVAILABLE: the RPC refused the full-range log query (${full.reason}) and a paged query ` +
            `(${page.ok ? "an answer that is not a list" : page.reason}). This is NOT a missing anchor.`,
        );
        return "unavailable";
      }
      if (page.result.length > 0) {
        notes.push(found);
        return "pass";
      }
      hi = lo - 1;
    }
    if (hi < from) {
      notes.push(absent);
      return "fail";
    }
    notes.push(
      `documentAnchor UNAVAILABLE: no anchor for CID ${cid} in blocks ${String(hi + 1)} to ${String(latest)}, the ` +
        `${String(budget)} paged queries this RPC allows (${full.reason}); blocks ${String(from)} to ${String(hi)} were ` +
        "not read. This is NOT a missing anchor: use an RPC that serves the full range, or raise maxLogQueries.",
    );
    return "unavailable";
  }

  /**
   * OPT-IN (rpcUrl), BUNDLE ONLY: eth_call registry(consentRef) for each cell's consentRef, as the app's
   * chain.js reads it. The record is tied to this receipt only through the Merkle root, which is trusted
   * only once the passkey assertion is bound to it.
   */
  private async verifyConsentAnchor(
    bundle: Record<string, unknown>,
    merkleRoot: string,
    citizenAssertion: CheckStatus,
    notes: string[],
    clock: RpcClock,
  ): Promise<CheckStatus> {
    const rpcUrl = this.opts.rpcUrl;
    if (!rpcUrl) {
      notes.push("consentAnchor skipped: pass an rpcUrl to read the consent's on-chain record.");
      return "skipped";
    }
    const refs = collectConsentRefs(bundle);
    if (refs.length === 0) {
      notes.push("consentAnchor skipped: the bundle carries no consentRef to read on chain.");
      return "skipped";
    }
    if (citizenAssertion !== "pass") {
      notes.push(
        "consentAnchor skipped: the bundle's Merkle root is not bound by a verified passkey assertion, so no on-chain " +
          "record can be tied to this receipt.",
      );
      return "skipped";
    }
    const chainId = this.chainId();
    const registry = this.registry();
    if (!registry) {
      notes.push(`consentAnchor skipped: no AgreelyRegistry address is known for chainId ${String(chainId)}.`);
      return "skipped";
    }

    const root = stripHex(merkleRoot).toLowerCase();
    const legacy = LEGACY_LAYOUT_CHAINS.has(chainId);
    let active = 0;
    let withdrawn = 0;
    let pending = 0;
    let unread = 0;
    const foreign: string[] = [];
    for (const ref of refs) {
      const call = await this.rpc(rpcUrl, "eth_call", [{ to: registry, data: REGISTRY_SELECTOR + stripHex(ref) }, "latest"], clock);
      const rec = call.ok ? decodeAnchorRecord(call.result, legacy) : null;
      const revoked = rec !== null && (rec.state === 2 || rec.revokedAt > 0);
      // An anchoredAt with neither state Active nor Revoked is a garbage record, not a pending anchor.
      if (!rec || (rec.anchoredAt > 0 && !revoked && rec.state !== 1)) {
        unread++;
      } else if (rec.anchoredAt === 0) {
        pending++;
      } else if (stripHex(rec.merkleRoot).toLowerCase() !== root) {
        foreign.push(ref);
      } else if (revoked) {
        withdrawn++;
      } else {
        active++;
      }
    }

    if (foreign.length > 0) {
      notes.push(
        `consentAnchor FAILED: the chain records consentRef ${foreign[0]!} under a different Merkle root than this ` +
          "bundle's, so the bundle's chain reference does not belong to this receipt.",
      );
      return "fail";
    }
    const counts = `${String(refs.length)} cell(s): ${String(active)} active, ${String(withdrawn)} withdrawn, ` +
      `${String(pending)} not anchored yet, ${String(unread)} unreadable`;
    if (active + withdrawn !== refs.length) {
      notes.push(
        `consentAnchor UNAVAILABLE on chainId ${String(chainId)} (${counts}). Anchoring is asynchronous and an RPC can ` +
          "fail: this is NOT a contradiction.",
      );
      return "unavailable";
    }
    notes.push(
      `Consent anchor FOUND on chainId ${String(chainId)} under this bundle's Merkle root (${counts}). A withdrawn ` +
        "cell is still authentic: check it before relying on the consent as current.",
    );
    return "pass";
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

  private registry(): string | null {
    return this.opts.registryAddress ?? REGISTRY_BY_CHAIN[this.chainId()] ?? null;
  }

  private timeoutMs(): number {
    return positiveInt(this.opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  private getLogs(
    rpcUrl: string,
    registry: string,
    from: number,
    to: number,
    topics: string[],
    clock: RpcClock,
  ): Promise<RpcOutcome> {
    return this.rpc(rpcUrl, "eth_getLogs", [
      { address: registry, fromBlock: toQuantity(from), toBlock: toQuantity(to), topics },
    ], clock);
  }

  /**
   * One JSON-RPC round trip, inside the verification's overall deadline. Every transport, HTTP or
   * JSON-RPC failure, and a passed deadline, is an outcome, never a throw.
   */
  private async rpc(rpcUrl: string, method: string, params: unknown[], clock: RpcClock): Promise<RpcOutcome> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    clock.deadline ??= Date.now() + positiveInt(this.opts.rpcDeadlineMs, DEFAULT_RPC_DEADLINE_MS);
    const remaining = clock.deadline - Date.now();
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

  private async resolveEd25519Key(issuer: string, vmId: string): Promise<Uint8Array | null> {
    const doc = await this.resolveDid(issuer);
    const vm = pickVerificationMethod(doc, vmId);
    if (!vm?.publicKeyMultibase) return null;
    try {
      return decodeEd25519PublicKeyMultibase(vm.publicKeyMultibase);
    } catch {
      return null;
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

function findWebAuthnProof(proofs: unknown[]): Record<string, unknown> | null {
  for (const p of proofs) {
    const obj = asObject(p);
    if (asString(obj["type"]) === "WebAuthnAssertion") return obj;
  }
  return null;
}

function pickVerificationMethod(doc: DidDocument | null, vmId: string): DidVerificationMethod | null {
  if (!isPlainObject(doc) || !Array.isArray(doc.verificationMethod)) return null;
  // A resolved document is outside input too: an entry that is not an object is skipped, never dereferenced.
  const methods = doc.verificationMethod.filter((m): m is DidVerificationMethod => isPlainObject(m));
  return methods.find((m) => m.id === vmId) ?? methods[0] ?? null;
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

function integrityFailure(r: Record<string, unknown>, offer: Record<string, unknown>): string | null {
  for (const k of Object.keys(r)) {
    if (!PASSKEY_RECEIPT_KEYS.has(k)) return `the receipt carries a top-level field outside the receipt format (${k})`;
  }
  if (!canonEqual(r["type"], PASSKEY_RECEIPT_TYPE)) return "the receipt type is not a passkey ConsentReceipt";
  if (!canonEqual(r["@context"], PASSKEY_RECEIPT_CONTEXT)) return "the receipt @context is not the consent receipt context";
  if (typeof r["id"] !== "string" || !r["id"].startsWith("urn:agreely:receipt:")) {
    return "the receipt id is not an urn:agreely:receipt identifier";
  }
  const subject = asObject(r["credentialSubject"]);
  for (const k of Object.keys(subject)) {
    if (k !== "id" && k !== "consent") return `credentialSubject carries a field the offer does not account for (${k})`;
  }
  const consent = asObject(subject["consent"]);
  for (const k of Object.keys(consent)) {
    if (!ALLOWED_CONSENT_KEYS.has(k)) return `the consent carries a field the offer does not account for (${k})`;
  }
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
  return null;
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
 * Decode `struct Anchor` from registry(bytes32). PACKED (mainnet): merkleRoot, anchoredAt, revokedAt,
 * state. LEGACY (Sepolia): state, merkleRoot, anchoredAt, revokedAt. Null on anything that is not that
 * struct in that layout, so a wrong layout reads as unreadable, never as a contradiction.
 */
function decodeAnchorRecord(
  result: unknown,
  legacy: boolean,
): { state: number; merkleRoot: string; anchoredAt: number; revokedAt: number } | null {
  const h = stripHex(asString(result)).toLowerCase();
  if (!/^[0-9a-f]{256}/.test(h)) return null;
  const word = (i: number): string => h.slice(i * 64, i * 64 + 64);
  const [rootW, anchoredW, revokedW, stateW] = legacy ? [word(1), word(2), word(3), word(0)] : [word(0), word(1), word(2), word(3)];
  if (!/^0{62}[0-9a-f]{2}$/.test(stateW) || !/^0{48}[0-9a-f]{16}$/.test(anchoredW) || !/^0{48}[0-9a-f]{16}$/.test(revokedW)) {
    return null;
  }
  const anchoredAt = parseInt(anchoredW, 16);
  const revokedAt = parseInt(revokedW, 16);
  if (!Number.isSafeInteger(anchoredAt) || !Number.isSafeInteger(revokedAt)) return null;
  return { state: parseInt(stateW, 16), merkleRoot: "0x" + rootW, anchoredAt, revokedAt };
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

function parseQuantity(v: unknown): number | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  const n = parseInt(v.slice(2), 16);
  return Number.isSafeInteger(n) ? n : null;
}

function toQuantity(n: number): string {
  return "0x" + n.toString(16);
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
