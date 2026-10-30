import { describe, expect, it } from "vitest";
import { departureCounts, departurePhaseOf, departureUrlOf } from "../../src/verify/issuerLive.js";
import type { CompanyKeyVerdict, IssuerDepartureReading } from "../../src/verify/types.js";
import { expectFields } from "./vectorCase.js";
import { readVector, verifyLive, type HttpAnswer, type LiveCase } from "./liveReads.js";

// vectors/issuer-departure.json: an issuer that left Agreely, as the /verify page reads it.

const V = readVector<{
  departureUrl: Array<{ did: string; url: string | null }>;
  phase: Array<{ name: string; sealedOn: string; purgedOn: string; signedAt: string; expect: string }>;
  counts: Array<{ name: string; departure: Omit<IssuerDepartureReading, "url">; companyKeyVerdict: CompanyKeyVerdict | null; expect: boolean }>;
  record: Array<{ name: string; answer: HttpAnswer; expect: Record<string, unknown> }>;
  cases: LiveCase[];
}>("issuer-departure.json");

const DEPARTURE_URL = "https://verify.agreely.ca/c/demo-co/departure.json";

describe("issuer-departure.json", () => {
  it.each(V.departureUrl.map((c) => [c.did, c] as const))("departureUrl %s", (_n, c) => {
    expect(departureUrlOf(c.did)).toBe(c.url);
  });

  it.each(V.phase.map((c) => [c.name, c] as const))("phase: %s", (_n, c) => {
    expect(departurePhaseOf({ sealedOn: c.sealedOn, purgedOn: c.purgedOn }, Date.parse(c.signedAt))).toBe(c.expect);
  });

  it.each(V.counts.map((c) => [c.name, c] as const))("counts: %s", (_n, c) => {
    const reading = { ...c.departure, url: DEPARTURE_URL } as IssuerDepartureReading;
    expect(departureCounts(reading, c.companyKeyVerdict ?? undefined)).toBe(c.expect);
  });

  it.each(V.record.map((c) => [c.name, c] as const))("record: %s", async (_n, c) => {
    const { result, asked } = await verifyLive({
      name: c.name,
      file: "receipts/a3v4.bundle.json",
      documents: "receipts/v4-did-documents.json",
      issuerDocument: { deactivated: true, deactivatedOn: "2026-08-01" },
      http: c.answer === null ? {} : { [DEPARTURE_URL]: c.answer },
      answers: null,
      options: {},
      expect: c.expect,
      asked: [DEPARTURE_URL],
    });
    expectFields(result, c.expect);
    expect(asked).toEqual([DEPARTURE_URL]);
  });

  it.each(V.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const { result, asked } = await verifyLive(c);
    expectFields(result, c.expect);
    expect(asked).toEqual(c.asked);
  });
});
