// The headline: an OFFLINE-first, honest consent-receipt verifier.
//
// A company-attested receipt is fully offline-sound: strip the proof, JCS-
// canonicalize the body (byte-identical to CompanyAttestedConsentReceipt::body),
// decode the multibase proofValue to a 64-byte Ed25519 signature, resolve the
// issuer DID to its key, and verify. That proves the COMPANY attested (under a
// domain-bound key) to a hand-signed PDF with hash H — it does NOT prove a human
// signed.
//
// A citizen receipt is HONESTLY PARTIAL offline: the company half signed the
// original OFFER (subject ref + full disclosure), which the receipt omits for
// unlinkability, so it cannot be re-derived here (use the server receipts/verify).
// The citizen WebAuthn assertion IS checkable and proves passkey-possession over
// the committed challenge — not the cell semantics.
//
// disclosureCopy (both types) and documentAnchor (opt-in) are the two additional
// offline-sound / on-chain proofs.

import { canonicalize } from "../crypto/jcs.js";
import {
  base64urlDecode,
  bytesEqual,
  decodeEd25519PublicKeyMultibase,
  hexDecode,
  multibaseDecode,
} from "../crypto/encoding.js";
import { keccak256Hex } from "../crypto/keccak.js";
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

const DEFAULT_COMPANY_HOST = "api.agreely.ca";
const DEFAULT_CITIZEN_BASE = "https://api.agreely.ca";
const DEFAULT_IPFS_GATEWAY = "https://gateway.lighthouse.storage/ipfs/";
const DEFAULT_CHAIN_ID = 84532;
const REGISTRY_BY_CHAIN: Record<number, string | null> = {
  84532: "0x36eaA3F10744FA3ABF140c1eED68F9B03ED7b65E",
  8453: null, // Base mainnet — not deployed yet
};
// keccak256("IdentityAnchored(bytes32,uint64)") — the document CID is anchored via
// anchorIdentity(commitment = keccak256(utf8(cid))).
const IDENTITY_ANCHORED_TOPIC = keccak256Hex("IdentityAnchored(bytes32,uint64)");

/** The verifier. `Agreely.verifyReceipt` is a thin static over this. */
export class ReceiptVerifier {
  constructor(private readonly opts: VerifyReceiptOptions = {}) {}

  /** Verify a parsed consent-receipt VC. Always resolves; never throws on a bad receipt. */
  async verify(receipt: unknown): Promise<ReceiptVerification> {
    const r = asObject(receipt);
    const type = receiptType(r);
    const notes: string[] = [];

    let companySignature: CheckStatus;
    let citizenAssertion: CheckStatus;

    if (type === "company_attested") {
      companySignature = await this.verifyCompanySignature(r, notes);
      citizenAssertion = "unsupported";
      notes.push(
        "A company-attested receipt carries no citizen passkey assertion, so citizenAssertion is not applicable.",
      );
    } else {
      companySignature = "unsupported";
      notes.push(
        "Company signature is UNSUPPORTED offline on a citizen receipt: the company signed the original offer " +
          "(including the subject reference and full disclosure), which the receipt omits for unlinkability. " +
          "Use the server receipts/verify endpoint for a sound company-signature check.",
      );
      citizenAssertion = await this.verifyCitizenAssertion(r, notes);
    }

    const disclosureCopy = await this.verifyDisclosureCopy(r, notes);
    const documentAnchor = await this.verifyDocumentAnchor(r, notes);

    const overall = decideOverall(type, companySignature, citizenAssertion, disclosureCopy, documentAnchor);

    return { receiptType: type, companySignature, citizenAssertion, disclosureCopy, documentAnchor, overall, notes };
  }

  /** COMPANY-ATTESTED: verify the Ed25519 proof over the canonical body. */
  private async verifyCompanySignature(r: Record<string, unknown>, notes: string[]): Promise<CheckStatus> {
    const issuer = asString(r["issuer"]);
    const proofs = asArray(r["proof"]);
    const proof = asObject(proofs[0]);
    const vm = asString(proof["verificationMethod"]);
    const proofValue = asString(proof["proofValue"]);

    if (!issuer || !proofValue) {
      notes.push("Company signature check FAILED: the receipt is missing its issuer or proofValue.");
      return "fail";
    }

    // The exact bytes the signature was taken over: the receipt body with `proof` removed.
    const body: Record<string, unknown> = { ...r };
    delete body["proof"];
    const canonical = new TextEncoder().encode(canonicalize(body));

    let signature: Uint8Array;
    try {
      signature = decodeMultibase(proofValue);
    } catch {
      notes.push("Company signature check FAILED: the proofValue is not a valid multibase signature.");
      return "fail";
    }

    const key = await this.resolveEd25519Key(issuer, vm);
    if (!key) {
      notes.push(
        `Company signature UNVERIFIABLE: could not resolve an Ed25519 key for issuer DID ${issuer} (key ${vm}).`,
      );
      return "fail";
    }

    const ok = verifyEd25519(key, canonical, signature);
    if (ok) {
      const pdfHash = asString(asObject(r["evidence"])["pdfHash"]);
      notes.push(`Company signature verified against issuer DID ${issuer} (key ${vm}).`);
      notes.push(
        `This proves the company ATTESTED to a hand-signed PDF (hash ${pdfHash}); it does NOT prove a human signed.`,
      );
      return "pass";
    }
    notes.push(
      `Company signature check FAILED against issuer DID ${issuer} (key ${vm}): the canonical receipt body does not ` +
        "match the signature. The receipt was altered after signing or the wrong key was resolved.",
    );
    return "fail";
  }

  /** CITIZEN: verify the WebAuthn assertion proves passkey-possession over the committed challenge. */
  private async verifyCitizenAssertion(r: Record<string, unknown>, notes: string[]): Promise<CheckStatus> {
    const subject = asObject(r["credentialSubject"]);
    const citizenDid = asString(subject["id"]);
    const proof = findWebAuthnProof(asArray(r["proof"]));
    if (!proof || !citizenDid) {
      notes.push("Citizen assertion UNVERIFIABLE: no WebAuthn assertion or citizen DID on the receipt.");
      return "fail";
    }
    const vm = asString(proof["verificationMethod"]);
    const coseHex = await this.resolveCoseKey(citizenDid, vm);
    if (!coseHex) {
      notes.push(`Citizen assertion UNVERIFIABLE: could not resolve a passkey for ${vm}.`);
      return "fail";
    }

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
      return "fail";
    }

    if (cose.alg === "unsupported") {
      notes.push(
        `Citizen assertion UNSUPPORTED: the passkey uses a COSE algorithm this offline verifier does not implement.`,
      );
      return "unsupported";
    }

    // Bind the assertion to the receipt's committed challenge.
    const challengeOk = challengeBinds(clientDataJSON, asString(proof["challenge"]));
    const sigOk = verifyWebAuthnAssertion(cose, authData, clientDataJSON, signature);

    if (sigOk && challengeOk) {
      notes.push(
        `Citizen passkey assertion verified against ${vm}: the holder of the registered passkey signed over the ` +
          `committed challenge ${asString(proof["challenge"])}.`,
      );
      notes.push(
        "This proves passkey POSSESSION over a committed challenge; it does NOT by itself prove the cell-level consent semantics.",
      );
      return "pass";
    }
    if (!challengeOk) {
      notes.push("Citizen assertion FAILED: the signed clientDataJSON challenge does not match the receipt challenge.");
    } else {
      notes.push("Citizen assertion FAILED: the WebAuthn signature did not verify against the resolved passkey.");
    }
    return "fail";
  }

  /** BOTH types: fetch the IPFS document body and match its disclosure to disclosureHash. */
  private async verifyDisclosureCopy(r: Record<string, unknown>, notes: string[]): Promise<CheckStatus> {
    const consent = asObject(asObject(r["credentialSubject"])["consent"]);
    const document = asObject(consent["document"]);
    const cid = asString(document["ipfsCid"]);
    const disclosureHash = asString(consent["disclosureHash"]);

    if (!cid || !disclosureHash) {
      notes.push(
        "disclosureCopy skipped: the receipt carries no document.ipfsCid + disclosureHash pair to fetch and compare.",
      );
      return "skipped";
    }
    if (this.opts.verifyDisclosure === false) {
      notes.push("disclosureCopy skipped: disclosure-copy verification was not requested.");
      return "skipped";
    }

    const gateway = this.opts.ipfsGateway ?? ((c: string) => DEFAULT_IPFS_GATEWAY + c);
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    let body: unknown;
    try {
      const res = await fetchImpl(gateway(cid));
      body = await res.json();
    } catch {
      notes.push(`disclosureCopy could not be checked: fetching the IPFS body for CID ${cid} failed.`);
      return "skipped";
    }

    // disclosureHash = "0x" + sha256(JCS(disclosureMap)); the pinned IPFS body wraps that map under `disclosure`.
    const disclosure = asObject(asObject(body)["disclosure"]);
    const computed = "0x" + createHash("sha256").update(canonicalize(disclosure)).digest("hex");
    if (computed === disclosureHash) {
      notes.push(`Disclosure copy verified: the IPFS document body matches the receipt disclosureHash ${disclosureHash}.`);
      return "pass";
    }
    notes.push(
      `disclosureCopy FAILED: the IPFS document body hashes to ${computed}, not the receipt disclosureHash ${disclosureHash}.`,
    );
    return "fail";
  }

  /** OPT-IN: is the document CID anchored in the AgreelyRegistry logs? Needs rpcUrl. */
  private async verifyDocumentAnchor(r: Record<string, unknown>, notes: string[]): Promise<CheckStatus> {
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

    const chainId = this.opts.chainId ?? DEFAULT_CHAIN_ID;
    const registry = this.opts.registryAddress ?? REGISTRY_BY_CHAIN[chainId] ?? null;
    if (!registry) {
      notes.push(`documentAnchor skipped: no AgreelyRegistry address is known for chainId ${String(chainId)}.`);
      return "skipped";
    }

    const commitment = keccak256Hex(cid); // keccak256(utf8(cid)) — the anchored bytes32
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    try {
      const res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [
            {
              address: registry,
              fromBlock: "0x0",
              toBlock: "latest",
              topics: [IDENTITY_ANCHORED_TOPIC, commitment],
            },
          ],
        }),
      });
      const json = (await res.json()) as { result?: unknown[] };
      const logs = Array.isArray(json.result) ? json.result : [];
      if (logs.length > 0) {
        notes.push(
          `Document anchor FOUND on chainId ${String(chainId)}: CID ${cid} existed at anchor time. ` +
            "This proves the DOCUMENT existed, NOT that any consent was given.",
        );
        return "pass";
      }
      notes.push(`documentAnchor FAILED: no on-chain anchor found for CID ${cid} on chainId ${String(chainId)}.`);
      return "fail";
    } catch {
      notes.push(`documentAnchor could not be checked: the RPC call to ${rpcUrl} failed.`);
      return "skipped";
    }
  }

  /** Resolve `slug` to the company did:web document (primitive). */
  async resolveCompanyDid(slug: string): Promise<DidDocument | null> {
    const host = this.opts.companyDidHost ?? DEFAULT_COMPANY_HOST;
    const did = `did:web:${host}:c:${slug}`;
    return this.resolveDid(did);
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

  private async resolveCoseKey(did: string, vmId: string): Promise<string | null> {
    const doc = await this.resolveDid(did);
    const vm = pickVerificationMethod(doc, vmId);
    return vm?.publicKeyCose ?? null;
  }

  private async resolveDid(did: string): Promise<DidDocument | null> {
    const resolver = this.opts.resolver ?? this.defaultResolver();
    return resolver(did);
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
        const res = await fetchImpl(url);
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
  if (!doc || !Array.isArray(doc.verificationMethod)) return null;
  const byId = doc.verificationMethod.find((m) => m.id === vmId);
  return byId ?? doc.verificationMethod[0] ?? null;
}

function challengeBinds(clientDataJSON: Uint8Array, receiptChallengeHex: string): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON).toString("utf8")) as { challenge?: string };
    if (typeof parsed.challenge !== "string") return false;
    const fromClient = base64urlDecode(parsed.challenge);
    const fromReceipt = hexDecode(receiptChallengeHex);
    return bytesEqual(fromClient, fromReceipt);
  } catch {
    return false;
  }
}

function decodeMultibase(proofValue: string): Uint8Array {
  // proofValue is a z-base58btc multibase of the raw 64-byte detached signature.
  return multibaseDecode(proofValue);
}

function decideOverall(
  type: ReceiptType,
  company: CheckStatus,
  citizen: CheckStatus,
  disclosure: CheckStatus,
  anchor: CheckStatus,
): ReceiptVerification["overall"] {
  if (type === "company_attested") {
    if (company !== "pass" || disclosure === "fail" || anchor === "fail") return "failed";
    return "verified";
  }
  // Citizen: never "verified" offline.
  if (citizen === "fail" || disclosure === "fail" || anchor === "fail") return "failed";
  return "partial";
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
