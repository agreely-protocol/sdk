import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { canonicalize } from "../../src/crypto/jcs.js";
import {
  CITIZEN_KEY_DOMAIN,
  KEY_OF_SELECTOR,
  LAG,
  SKEW,
  citizenHalfReading,
  citizenKeyChainState,
  citizenKeyClaim,
  citizenKeyFingerprint,
  decodeKeyRecord,
  grantedAtSeconds,
  keyOfCalldata,
  parseCitizenKeySalt,
  type CitizenKeyChainState,
  type KeyRecord,
} from "../../src/verify/citizenKeyChain.js";
import type { DidDocument } from "../../src/verify/types.js";
import { vectorChainFetch, type VectorAnswers } from "./registry.js";
import { expectFields } from "./vectorCase.js";

// vectors/citizen-key-fingerprint.json is the web verifier's frozen file, copied verbatim; citizen-key-amber.json adds
// the clock (`now`) and the configured registry (keyOfRegistry) it does not carry; citizen-key-chain.json reads both
// keys through verifyReceipt, answered by selector.

const read = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8")) as T;

type Strings<T> = { [K in keyof T]: string };
const record = (r: Strings<KeyRecord> | null): KeyRecord | null =>
  r === null
    ? null
    : { validFrom: BigInt(r.validFrom), anchoredAt: BigInt(r.anchoredAt), retiredAt: BigInt(r.retiredAt), voidedAt: BigInt(r.voidedAt) };
const time = (v: string | null | undefined): bigint | null => (v === null || v === undefined ? null : BigInt(v));
const hex = (b: Uint8Array): string => "0x" + Buffer.from(b).toString("hex");

interface AnchorIn {
  rootMatches: boolean | null;
  anchoredAt: string | null;
  earliestAnchoredAt?: string | null;
}
const anchor = (a: AnchorIn | null | undefined) =>
  a === null || a === undefined
    ? null
    : {
        rootMatches: a.rootMatches,
        anchoredAt: time(a.anchoredAt),
        ...(a.earliestAnchoredAt !== undefined ? { earliestAnchoredAt: time(a.earliestAnchoredAt) } : {}),
      };

const FP = read<{
  constants: { domain: string; LAG: string; SKEW: string; keyOfSelector: string };
  fingerprint: Array<{ name: string; did: string; keyCose: string; salt: string; claim: unknown; canonicalString: string; keyThumbprint: string; fingerprint: string }>;
  saltParse: Array<{ name: string; field: unknown; expect: string | null }>;
  keyOfCalldata: Array<{ name: string; fingerprint: string; calldata: string }>;
  keyOfDecode: Array<{ name: string; data: unknown; expect: Strings<KeyRecord> | null }>;
  grantedAtSeconds: Array<{ name: string; grantedAt: unknown; G: string | null }>;
  chainState: Array<{ name: string; saltAbsent?: boolean; saltField?: unknown; record: Strings<KeyRecord> | null; rpcError: boolean; G: string | null; expect: CitizenKeyChainState }>;
  halfReading: Array<{ name: string; chainState: CitizenKeyChainState; didStanding: string; consentAnchor: AnchorIn | null; G: string | null; expect: { colour: string; reason: string } }>;
}>("citizen-key-fingerprint.json");

describe("citizen-key-fingerprint.json, the frozen file, every section", () => {
  it("constants", () => {
    expect(CITIZEN_KEY_DOMAIN).toBe(FP.constants.domain);
    expect(LAG).toBe(BigInt(FP.constants.LAG));
    expect(SKEW).toBe(BigInt(FP.constants.SKEW));
    expect(KEY_OF_SELECTOR).toBe(FP.constants.keyOfSelector);
  });

  it.each(FP.fingerprint.map((c) => [c.name, c] as const))("fingerprint %s", (_n, c) => {
    const claim = citizenKeyClaim(c.did, c.keyCose);
    expect(claim).toEqual(c.claim);
    expect(claim.keyThumbprint).toBe(c.keyThumbprint);
    expect(canonicalize(claim)).toBe(c.canonicalString);
    expect(citizenKeyFingerprint(c.did, c.keyCose, c.salt)).toBe(c.fingerprint);
  });

  it.each(FP.saltParse.map((c) => [c.name, c] as const))("saltParse %s", (_n, c) => {
    const parsed = parseCitizenKeySalt(c.field);
    expect(parsed.status === "ok" ? hex(parsed.salt) : null).toBe(c.expect);
  });

  it.each(FP.keyOfCalldata.map((c) => [c.name, c] as const))("keyOfCalldata %s", (_n, c) => {
    expect(keyOfCalldata(c.fingerprint)).toBe(c.calldata);
  });

  it.each(FP.keyOfDecode.map((c) => [c.name, c] as const))("keyOfDecode %s", (_n, c) => {
    expect(decodeKeyRecord(c.data)).toEqual(record(c.expect));
  });

  it.each(FP.grantedAtSeconds.map((c) => [c.name, c] as const))("grantedAtSeconds %s", (_n, c) => {
    const g = grantedAtSeconds(c.grantedAt);
    expect(g === null ? null : String(g)).toBe(c.G);
  });

  it.each(FP.chainState.map((c) => [c.name, c] as const))("chainState %s", (_n, c) => {
    const state = citizenKeyChainState({
      saltField: c.saltAbsent === true ? undefined : c.saltField,
      record: record(c.record),
      rpcError: c.rpcError,
      G: time(c.G),
    });
    expect(state).toBe(c.expect);
  });

  it.each(FP.halfReading.map((c) => [c.name, c] as const))("halfReading %s", (_n, c) => {
    const reading = citizenHalfReading({ chainState: c.chainState, didStanding: c.didStanding, consentAnchor: anchor(c.consentAnchor), G: time(c.G) });
    expect(reading).toEqual(c.expect);
  });
});

const AMBER = read<{
  G: string;
  cases: Array<{
    name: string;
    chain: { saltAbsent?: boolean; saltField?: unknown; record: Strings<KeyRecord> | null; rpcError: boolean; now: string | null };
    half: { didStanding: string; keyOfRegistry: boolean; consentAnchor: AnchorIn | null };
    expect: { chainState: CitizenKeyChainState; colour: string; reason: string };
  }>;
}>("citizen-key-amber.json");

describe("citizen-key-amber.json: the clock and the configured registry", () => {
  it.each(AMBER.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const G = BigInt(AMBER.G);
    const chainState = citizenKeyChainState({
      saltField: c.chain.saltAbsent === true ? undefined : c.chain.saltField,
      record: record(c.chain.record),
      rpcError: c.chain.rpcError,
      G,
      now: time(c.chain.now),
    });
    expect(chainState).toBe(c.expect.chainState);
    const half = citizenHalfReading({
      chainState,
      didStanding: c.half.didStanding,
      consentAnchor: anchor(c.half.consentAnchor),
      G,
      keyOfRegistry: c.half.keyOfRegistry,
    });
    expect(half).toEqual({ colour: c.expect.colour, reason: c.expect.reason });
  });
});

const READS = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/registry-reads.json", import.meta.url)), "utf8")) as {
  keyOf: { selector: string; cases: Array<{ name: string; calldata: string; returnData: string; decoded: Record<string, number> }> };
};

describe("registry-reads.json: keyOf(bytes32) as the contract answers it", () => {
  it.each(READS.keyOf.cases.map((c) => [c.name, c] as const))("keyOf %s", (_n, c) => {
    expect(c.calldata.slice(0, 10)).toBe(KEY_OF_SELECTOR);
    expect(keyOfCalldata("0x" + c.calldata.slice(10))).toBe(c.calldata);
    const decoded = decodeKeyRecord(c.returnData);
    expect(decoded).not.toBeNull();
    expect(Object.fromEntries(Object.entries(decoded!).map(([k, v]) => [k, Number(v)]))).toEqual(c.decoded);
  });
});

interface ChainCase {
  name: string;
  rpc: boolean;
  now: string;
  citizenKeySalt?: string | null;
  answers: VectorAnswers | null;
  expect: Record<string, unknown> & { absent?: string[]; citizenKey?: Record<string, string> };
}

const CHAIN = read<{ bundle: string; fingerprint: string; keyOfCalldata: string; companyKeyOfCalldata: string; getCompanyDidCalldata: string; cases: ChainCase[] }>(
  "citizen-key-chain.json",
);
const DID_DOCS = read<Record<string, DidDocument>>("receipts/did-documents.json");

describe("citizen-key-chain.json: both keys read on chain through verifyReceipt", () => {
  it.each(CHAIN.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const bundle = read<Record<string, unknown>>(CHAIN.bundle);
    if (c.citizenKeySalt === null) delete bundle["citizenKeySalt"];
    else if (c.citizenKeySalt !== undefined) bundle["citizenKeySalt"] = c.citizenKeySalt;
    const rpc = vectorChainFetch(c.answers ?? {});
    const result = await Agreely.verifyReceipt(bundle, {
      resolver: (did) => DID_DOCS[did] ?? null,
      now: () => Number(c.now) * 1000,
      ...(c.rpc ? { rpcUrl: "https://rpc.test", chainId: 84532, fetch: rpc.fetch } : {}),
    });
    expectFields(result, c.expect);
    const data = rpc.calls.map((call) => (call.params[0] as { data?: string }).data);
    if (!c.rpc) expect(rpc.calls).toHaveLength(0);
    // A salt absent or malformed is read without asking the chain; a well-formed one asks keyOf(fp) once.
    const keyOfReads = data.filter((d) => d?.startsWith(KEY_OF_SELECTOR));
    if (!c.rpc || c.citizenKeySalt !== undefined) expect(keyOfReads).toHaveLength(0);
    else if (c.expect.citizenKey !== undefined) expect(keyOfReads).toEqual([CHAIN.keyOfCalldata]);
    if (c.expect["companyKeyRegistry"] !== undefined) {
      expect(data).toContain(CHAIN.companyKeyOfCalldata);
      expect(data).toContain(CHAIN.getCompanyDidCalldata);
    }
  });
});
