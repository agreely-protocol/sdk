// The company's signing key on chain, as the web verifier reads it (public/assets/verify/issuer.js): the key's window
// on the company's domain, companyKeyOf(keccak256(domain), sha256(raw Ed25519 key)), judged at the instant the key
// signed, and getCompanyDid(keccak256(domain)) for the key the company holds today. Vector:
// vectors/company-key-windows.json.

import { keccak256Hex } from "../crypto/keccak.js";
import { keyWindowState, SKEW, type KeyRecord } from "./citizenKeyChain.js";

export const COMPANY_KEY_OF_SELECTOR = keccak256Hex("companyKeyOf(bytes32,bytes32)").slice(0, 10);
export const GET_COMPANY_DID_SELECTOR = keccak256Hex("getCompanyDid(bytes32)").slice(0, 10);

/**
 *   authentic            in force at the signing instant
 *   key-not-authorised   not in force then: retired at or before it, or (notYetEffective) not valid yet
 *   signed-after-anchor  the signing instant is later than the consent anchor allows (anchoredAt + SKEW)
 *   pending              no window for this key on this domain
 *   voided               the window was voided: never authentic, whatever else it says
 *   recorded-late        declared in force then, but recorded more than LAG after it
 *   retired-issuer-dated in force then, but that instant is the issuer's own date and the key has since been retired
 *   unknown              unreadable
 */
export type CompanyKeyWindowVerdict =
  | "authentic"
  | "key-not-authorised"
  | "signed-after-anchor"
  | "pending"
  | "voided"
  | "recorded-late"
  | "retired-issuer-dated"
  | "unknown";

/** The check a verdict reads as: only authentic passes; a key refused at the signing instant fails; anything else is not confirmed. */
export function companyKeyStatusOf(verdict: CompanyKeyWindowVerdict): "pass" | "fail" | "unavailable" {
  if (verdict === "authentic") return "pass";
  return verdict === "key-not-authorised" || verdict === "signed-after-anchor" || verdict === "voided" ? "fail" : "unavailable";
}

/** The clock a receipt's signing instant is judged against. */
export interface ReceiptClock {
  /** The latest consent anchor holding the receipt's trusted root, in unix seconds; null when none. */
  anchoredAt: number | null;
  /** No such anchor: the signing instant is the issuer's own date. */
  issuerDatedOnly: boolean;
}

/**
 * The company domain the issuer DID document names: its first alsoKnownAs, the host of a did:web, lowercased. Null when
 * the document names none.
 */
export function companyDomainFromDoc(doc: unknown): string | null {
  const aka = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>)["alsoKnownAs"] : undefined;
  const first = Array.isArray(aka) ? aka.find((x): x is string => typeof x === "string" && x !== "") : undefined;
  if (first === undefined) return null;
  let domain = first;
  if (domain.startsWith("did:web:")) {
    const host = domain.slice("did:web:".length).split(":")[0]!;
    try {
      domain = decodeURIComponent(host);
    } catch {
      domain = host;
    }
  }
  domain = domain.trim().toLowerCase();
  return domain === "" ? null : domain;
}

/** domainHash = keccak256(lowercased company domain), the registry's key for a company. */
export function domainHashOf(domain: string): string {
  return keccak256Hex(domain.trim().toLowerCase());
}

export function companyKeyOfCalldata(domainHash: string, keyId: string): string {
  return COMPANY_KEY_OF_SELECTOR + bytes32(domainHash) + bytes32(keyId);
}

export function getCompanyDidCalldata(domainHash: string): string {
  return GET_COMPANY_DID_SELECTOR + bytes32(domainHash);
}

function bytes32(h: string): string {
  const hex = (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("not a bytes32");
  return hex;
}

/**
 * Decode getCompanyDid: an outer offset, then (string did, bytes32 keyId, bytes publicKey, string didDocCid, uint64
 * verifiedAt, uint64 rotatedAt, uint8 status, address controller). Only the members this verifier reads are kept;
 * null on a short or malformed answer.
 */
export function decodeCompanyDid(data: unknown): { keyId: string; status: number; verifiedAt: bigint; rotatedAt: bigint } | null {
  if (typeof data !== "string") return null;
  const h = (data.startsWith("0x") ? data.slice(2) : data).toLowerCase();
  if (h.length < 64 || h.length % 64 !== 0 || !/^[0-9a-f]*$/.test(h)) return null;
  const words = h.match(/.{64}/g) ?? [];
  const outer = BigInt("0x" + words[0]!);
  if (outer % 32n !== 0n || outer / 32n + 8n > BigInt(words.length)) return null;
  const t = words.slice(Number(outer / 32n));
  const uint = (w: string, bits: number): bigint | null => {
    const v = BigInt("0x" + w);
    return v < 1n << BigInt(bits) ? v : null;
  };
  const verifiedAt = uint(t[4]!, 64);
  const rotatedAt = uint(t[5]!, 64);
  const status = uint(t[6]!, 8);
  if (verifiedAt === null || rotatedAt === null || status === null) return null;
  return { keyId: "0x" + t[1]!, status: Number(status), verifiedAt, rotatedAt };
}

/**
 * The verdict on a company key at the signing instant G, from its own window (the rule citizen keys follow). G is
 * chosen by the signer; the instant the signer cannot choose is the consent anchor, which bounds G from above.
 */
export function companyKeyVerdict(
  record: KeyRecord | null,
  G: number | null,
  clock: ReceiptClock,
): { verdict: CompanyKeyWindowVerdict; window: { validFrom: bigint; retiredAt: bigint } | null; notYetEffective: boolean } {
  if (G === null || !Number.isSafeInteger(G)) return { verdict: "unknown", window: null, notYetEffective: false };
  const state = keyWindowState(record, G);
  const anchoredAt = clock.anchoredAt;
  if (state === "inForce" && anchoredAt !== null && Number.isSafeInteger(anchoredAt) && anchoredAt > 0 && BigInt(G) > BigInt(anchoredAt) + SKEW) {
    return { verdict: "signed-after-anchor", window: null, notYetEffective: false };
  }
  if (state === "inForce" && clock.issuerDatedOnly && record!.retiredAt !== 0n) {
    return { verdict: "retired-issuer-dated", window: null, notYetEffective: false };
  }
  const verdict: CompanyKeyWindowVerdict =
    state === "inForce"
      ? "authentic"
      : state === "notInForce"
        ? "key-not-authorised"
        : state === "pending"
          ? "pending"
          : state === "voided"
            ? "voided"
            : state === "recordedLate"
              ? "recorded-late"
              : "unknown";
  return {
    verdict,
    window: state === "inForce" ? { validFrom: record!.validFrom, retiredAt: record!.retiredAt } : null,
    notYetEffective: state === "notInForce" && BigInt(G) < record!.validFrom,
  };
}

/** The clock a receipt's consent anchor gives: its time when it holds the receipt's trusted root, else the issuer's own date. */
export function receiptClockOf(anchor: { rootMatches: boolean | null; anchoredAt: number | null } | null): ReceiptClock {
  return anchor !== null && anchor.rootMatches === true && anchor.anchoredAt !== null && anchor.anchoredAt > 0
    ? { anchoredAt: anchor.anchoredAt, issuerDatedOnly: false }
    : { anchoredAt: null, issuerDatedOnly: true };
}
