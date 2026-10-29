// The person's key on chain, as the web verifier reads it (public/assets/verify/citizen-key-chain.js):
//
//   claim = {"did": <DID verbatim>, "domain": "agreely:citizen-key:v1", "keyThumbprint": keccak256(<COSE_Key bytes>)}
//   fp    = keccak256( JCS(claim) || salt32 )
//
// then one keyOf(fp) read, and the rule that turns the record into a reading. Every on-chain time is a uint64 held as
// a bigint: a number would silently round above 2^53. Vectors: vectors/citizen-key-fingerprint.json (frozen) and
// vectors/citizen-key-amber.json.

import { canonicalize } from "../crypto/jcs.js";
import { hexDecode } from "../crypto/encoding.js";
import { keccak256, keccak256Hex } from "../crypto/keccak.js";

export const CITIZEN_KEY_DOMAIN = "agreely:citizen-key:v1";
/** How far before its anchor block a declared validFrom is still trusted, in seconds (72 h). */
export const LAG = 259200n;
/** How far after the consent's anchor block a grantedAt may still fall, in seconds. */
export const SKEW = 300n;
export const KEY_OF_SELECTOR = keccak256Hex("keyOf(bytes32)").slice(0, 10);

const SALT_PATTERN = /^0x[0-9a-f]{64}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const KEY_RECORD_PATTERN = /^0x[0-9a-fA-F]{256}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** `/did` answers that do not refuse the key. */
const DID_NOT_REFUSING = new Set(["confirmed", "unknownIdentity", "unreachable"]);

/** A key window as the registry records it (keyOf, companyKeyOf): four uint64 unix-second times. */
export interface KeyRecord {
  validFrom: bigint;
  anchoredAt: bigint;
  retiredAt: bigint;
  voidedAt: bigint;
}

export type CitizenKeyChainState =
  | "notLinked"
  | "unreadable"
  | "unreachable"
  | "pending"
  | "notRecorded"
  | "voided"
  | "notInForce"
  | "recordedLate"
  | "inForce";

export type KeyWindowState = "unreadable" | "pending" | "voided" | "notInForce" | "recordedLate" | "inForce";

export type HalfColour = "green" | "red" | "amber" | "neutral";

/** The consent anchor the person's half is read against: the LATEST and the EARLIEST anchor under the trusted root. */
export interface HalfConsentAnchor {
  rootMatches: boolean | null;
  anchoredAt: bigint | number | null;
  earliestAnchoredAt?: bigint | number | null;
}

/** A uint64 time as a bigint, or null. Accepts a bigint or a non-negative safe-integer number. */
function toTime(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

function asBytes(v: string | Uint8Array): Uint8Array {
  return v instanceof Uint8Array ? v : hexDecode(v);
}

/** The claim object. keyCose is the COSE_Key the assertion verified with; hex is only a transport for its bytes. */
export function citizenKeyClaim(did: string, keyCose: string | Uint8Array): { did: string; domain: string; keyThumbprint: string } {
  return { did, domain: CITIZEN_KEY_DOMAIN, keyThumbprint: "0x" + Buffer.from(keccak256(asBytes(keyCose))).toString("hex") };
}

/** fp = keccak256( JCS(claim) || salt ), as 0x + 64 lowercase hex. Throws on a salt that is not 32 bytes. */
export function citizenKeyFingerprint(did: string, keyCose: string | Uint8Array, salt: string | Uint8Array): string {
  const s = asBytes(salt);
  if (s.length !== 32) throw new Error("citizen key salt must be exactly 32 bytes");
  const claim = new TextEncoder().encode(canonicalize(citizenKeyClaim(did, keyCose)));
  const joined = new Uint8Array(claim.length + s.length);
  joined.set(claim, 0);
  joined.set(s, claim.length);
  return keccak256Hex(joined);
}

/**
 * The bundle's top-level citizenKeySalt. Absent (undefined) is "absent"; anything other than "0x" + 64 LOWERCASE hex
 * is "unreadable". Never throws.
 */
export function parseCitizenKeySalt(field: unknown): { status: "ok"; salt: Uint8Array } | { status: "absent" } | { status: "unreadable" } {
  if (field === undefined) return { status: "absent" };
  if (typeof field !== "string" || !SALT_PATTERN.test(field)) return { status: "unreadable" };
  return { status: "ok", salt: hexDecode(field) };
}

/** The eth_call data for keyOf(fp). Throws on a fingerprint that is not 32 bytes of hex. */
export function keyOfCalldata(fp: string): string {
  if (!BYTES32_PATTERN.test(fp)) throw new Error("the fingerprint must be 0x + 64 hex");
  return KEY_OF_SELECTOR + fp.slice(2).toLowerCase();
}

/**
 * Decode keyOf (or companyKeyOf): exactly four 32-byte words, each a uint64. Anything else (a wrong length, a word whose
 * high 24 bytes are not zero, a non-string, the empty answer of an address with no code) is null: `unreadable`.
 */
export function decodeKeyRecord(data: unknown): KeyRecord | null {
  if (typeof data !== "string" || !KEY_RECORD_PATTERN.test(data)) return null;
  const words: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    const word = data.slice(2 + i * 64, 2 + (i + 1) * 64);
    if (!/^0{48}$/.test(word.slice(0, 48))) return null;
    words.push(BigInt("0x" + word.slice(48)));
  }
  const [validFrom, anchoredAt, retiredAt, voidedAt] = words as [bigint, bigint, bigint, bigint];
  return { validFrom, anchoredAt, retiredAt, voidedAt };
}

/**
 * grantedAt (RFC 3339, an explicit offset required) as whole seconds since the epoch, floored, or null. A fractional
 * second never rounds up: a same-second consent must not read as later than its validFrom.
 */
export function grantedAtSeconds(grantedAt: unknown): number | null {
  if (typeof grantedAt !== "string") return null;
  const m = RFC3339.exec(grantedAt);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  ) {
    return null;
  }
  const zone = m[8]!;
  let offset = 0;
  if (zone !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offset = (zone.startsWith("+") ? 1 : -1) * (oh * 3600 + om * 60);
  }
  return ms / 1000 - offset;
}

/**
 * What one key window says at the instant G, the rule citizen keys and company keys share: unreadable, pending (not
 * anchored yet), voided, notInForce (G before validFrom, or at or after retiredAt), recordedLate (G more than LAG
 * before the block that recorded the window) or inForce. A voided window is never in force, whatever else it says.
 */
export function keyWindowState(record: KeyRecord | null, G: bigint | number | null): KeyWindowState {
  if (!record || typeof record !== "object") return "unreadable";
  const validFrom = toTime(record.validFrom);
  const anchoredAt = toTime(record.anchoredAt);
  const retiredAt = toTime(record.retiredAt);
  const voidedAt = toTime(record.voidedAt);
  const g = toTime(G);
  if (validFrom === null || anchoredAt === null || retiredAt === null || voidedAt === null || g === null) {
    return "unreadable";
  }
  if (anchoredAt === 0n) return "pending";
  if (voidedAt !== 0n) return "voided";
  if (g < validFrom || (retiredAt !== 0n && g >= retiredAt)) return "notInForce";
  if (g < anchoredAt - LAG) return "recordedLate";
  return "inForce";
}

/**
 * What the chain says about the person's key at G; the first rule that applies wins: notLinked (no salt), unreadable
 * (malformed salt), unreachable (read failure), then keyWindowState, where a record never anchored reads pending
 * until `now` reaches G + LAG and notRecorded from then on.
 * TRAP: `now` is an explicit input so a vector can pin it; without it a record never anchored stays pending forever.
 */
export function citizenKeyChainState(input: {
  saltField: unknown;
  record?: KeyRecord | null;
  rpcError?: boolean;
  G: bigint | number | null;
  now?: bigint | number | null;
}): CitizenKeyChainState {
  const salt = parseCitizenKeySalt(input.saltField);
  if (salt.status === "absent") return "notLinked";
  if (salt.status === "unreadable") return "unreadable";
  if (input.rpcError === true) return "unreachable";
  const state = keyWindowState(input.record ?? null, input.G);
  const t = toTime(input.now ?? null);
  const g = toTime(input.G);
  if (state === "pending" && t !== null && g !== null && t >= g + LAG) return "notRecorded";
  return state;
}

/**
 * The person's half: the chain state combined with the key's `/did` standing and the consent's own anchor. Any refusal
 * wins. keyOfRegistry: the verifier's own configured registry serves keyOf and was consulted (never the file); only
 * then does a receipt with no salt read amber.
 */
export function citizenHalfReading(input: {
  chainState: CitizenKeyChainState;
  didStanding: string;
  consentAnchor?: HalfConsentAnchor | null;
  G: bigint | number | null;
  keyOfRegistry?: boolean;
}): { colour: HalfColour; reason: string } {
  const { chainState, didStanding } = input;
  const consentAnchor = input.consentAnchor ?? null;
  const g = toTime(input.G);
  const matching = consentAnchor !== null && consentAnchor.rootMatches === true;
  const anchoredAt = matching ? toTime(consentAnchor.anchoredAt) : null;
  const anchored = anchoredAt !== null;
  const earliest =
    matching && consentAnchor.earliestAnchoredAt !== undefined ? toTime(consentAnchor.earliestAnchoredAt) : anchoredAt;
  const grantedAfterAnchor = anchored && g !== null && g > anchoredAt + SKEW;
  // This bounds the key's window, not where G sits in it: only the ceremony server can date a consent this early.
  const consentRecordedLate = anchored && earliest !== null && g !== null && g < earliest - LAG;
  const reading = (colour: HalfColour, reason: string) => ({ colour, reason });
  if (chainState === "notInForce") return reading("red", "notInForce");
  if (didStanding === "refused") return reading("red", chainState === "inForce" ? "conflict" : "didRefused");
  if (grantedAfterAnchor) return reading("red", "grantedAfterConsentAnchor");
  if (chainState === "recordedLate" || chainState === "voided") return reading("amber", chainState);
  if (consentRecordedLate) return reading("amber", "consentRecordedLate");
  if (chainState === "inForce") {
    if (!anchored || g === null) return reading("amber", "consentNotAnchored");
    if (DID_NOT_REFUSING.has(didStanding)) return reading("green", "chainConfirmed");
    return reading("amber", "didNotConsulted");
  }
  if (chainState === "notLinked") return reading(input.keyOfRegistry === true ? "amber" : "neutral", "notLinked");
  if (chainState === "pending" || chainState === "unreachable") return reading("neutral", chainState);
  if (chainState === "notRecorded") return reading("amber", "notRecorded");
  return reading("amber", "unreadable");
}

/** The amber readings that withhold the person's key whatever its DID document says. */
export const CHAIN_WITHHOLDS: ReadonlySet<string> = new Set(["voided", "notLinked", "notRecorded", "unreadable", "consentRecordedLate"]);
