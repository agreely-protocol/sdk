import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeKeyRecord, type KeyRecord } from "../../src/verify/citizenKeyChain.js";
import {
  COMPANY_KEY_OF_SELECTOR,
  GET_COMPANY_DID_SELECTOR,
  companyDomainFromDoc,
  companyKeyOfCalldata,
  companyKeyStatusOf,
  companyKeyVerdict,
  decodeCompanyDid,
  domainHashOf,
  getCompanyDidCalldata,
  receiptClockOf,
  type CompanyKeyWindowVerdict,
} from "../../src/verify/companyKey.js";

// vectors/company-key-windows.json: the company key's window judged at the signing instant against the consent
// anchor's clock, as the web verifier's companyKeyVerdict does (issuer.js).

const read = <T>(rel: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as T;

type Strings<T> = { [K in keyof T]: string };

const WINDOWS = read<{
  windows: Array<{
    name: string;
    record: Strings<KeyRecord> | null;
    G: string | null;
    clock: { anchoredAt: string | null; issuerDatedOnly: boolean };
    expect: { verdict: CompanyKeyWindowVerdict; notYetEffective: boolean; window: { validFrom: string; retiredAt: string } | null };
  }>;
  receiptClock: Array<{
    name: string;
    consentAnchor: { rootMatches: boolean | null; anchoredAt: string } | null;
    expect: { anchoredAt: string | null; issuerDatedOnly: boolean };
  }>;
  statusOf: Record<CompanyKeyWindowVerdict, string>;
}>("../../vectors/company-key-windows.json");

describe("company-key-windows.json", () => {
  it.each(WINDOWS.windows.map((c) => [c.name, c] as const))("window: %s", (_n, c) => {
    const record = c.record === null
      ? null
      : { validFrom: BigInt(c.record.validFrom), anchoredAt: BigInt(c.record.anchoredAt), retiredAt: BigInt(c.record.retiredAt), voidedAt: BigInt(c.record.voidedAt) };
    const clock = { anchoredAt: c.clock.anchoredAt === null ? null : Number(c.clock.anchoredAt), issuerDatedOnly: c.clock.issuerDatedOnly };
    const pit = companyKeyVerdict(record, c.G === null ? null : Number(c.G), clock);
    expect({
      verdict: pit.verdict,
      notYetEffective: pit.notYetEffective,
      window: pit.window === null ? null : { validFrom: String(pit.window.validFrom), retiredAt: String(pit.window.retiredAt) },
    }).toEqual(c.expect);
  });

  it.each(WINDOWS.receiptClock.map((c) => [c.name, c] as const))("receipt clock: %s", (_n, c) => {
    const clock = receiptClockOf(c.consentAnchor === null ? null : { rootMatches: c.consentAnchor.rootMatches, anchoredAt: Number(c.consentAnchor.anchoredAt) });
    expect({ anchoredAt: clock.anchoredAt === null ? null : String(clock.anchoredAt), issuerDatedOnly: clock.issuerDatedOnly }).toEqual(c.expect);
  });

  it("every verdict reads as the check the table names", () => {
    for (const [verdict, status] of Object.entries(WINDOWS.statusOf)) {
      expect(companyKeyStatusOf(verdict as CompanyKeyWindowVerdict), verdict).toBe(status);
    }
  });
});

const READS = read<{
  fixture: { domainHash: string };
  companyKeyOf: { selector: string; cases: Array<{ name: string; calldata: string; returnData: string; decoded: Record<string, number> }> };
  getCompanyDid: { selector: string; cases: Array<{ name: string; calldata: string; returnData: string; decoded: Record<string, unknown> }> };
}>("../fixtures/registry-reads.json");

describe("registry-reads.json: companyKeyOf and getCompanyDid as the contract answers them", () => {
  it.each(READS.companyKeyOf.cases.map((c) => [c.name, c] as const))("companyKeyOf %s", (_n, c) => {
    expect(COMPANY_KEY_OF_SELECTOR).toBe(READS.companyKeyOf.selector);
    expect(companyKeyOfCalldata("0x" + c.calldata.slice(10, 74), "0x" + c.calldata.slice(74))).toBe(c.calldata);
    const decoded = decodeKeyRecord(c.returnData);
    expect(Object.fromEntries(Object.entries(decoded!).map(([k, v]) => [k, Number(v)]))).toEqual(c.decoded);
  });

  it.each(READS.getCompanyDid.cases.map((c) => [c.name, c] as const))("getCompanyDid %s", (_n, c) => {
    expect(GET_COMPANY_DID_SELECTOR).toBe(READS.getCompanyDid.selector);
    expect(getCompanyDidCalldata("0x" + c.calldata.slice(10))).toBe(c.calldata);
    expect(decodeCompanyDid(c.returnData)).toEqual({
      keyId: c.decoded["keyId"],
      status: c.decoded["status"],
      verifiedAt: BigInt(c.decoded["verifiedAt"] as number),
      rotatedAt: BigInt(c.decoded["rotatedAt"] as number),
    });
  });

  it("a short or malformed getCompanyDid answer is unreadable", () => {
    const answer = READS.getCompanyDid.cases[1]!.returnData;
    expect(decodeCompanyDid(answer.slice(0, 2 + 64 * 4))).toBeNull();
    expect(decodeCompanyDid("0x")).toBeNull();
    expect(decodeCompanyDid(null)).toBeNull();
  });
});

describe("the company domain the issuer document names", () => {
  it("is its first alsoKnownAs, the host of a did:web, lowercased, and hashed with keccak256", () => {
    expect(companyDomainFromDoc({ alsoKnownAs: ["did:web:Demo-Co.Example:c:x"] })).toBe("demo-co.example");
    expect(companyDomainFromDoc({ alsoKnownAs: ["Acme.Example"] })).toBe("acme.example");
    expect(companyDomainFromDoc({ alsoKnownAs: [] })).toBeNull();
    expect(companyDomainFromDoc({})).toBeNull();
    expect(domainHashOf("demo-co.example")).toBe("0xcdfabfbbf6dbc32d32f7225eacea5193d2503577c7969ced26bc7fcc1548cdee");
  });
});
