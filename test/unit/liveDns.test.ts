import { describe, expect, it } from "vitest";
import { DEFAULT_DOH_URL, liveDnsQueryUrl, liveDnsStatusOf } from "../../src/verify/issuerLive.js";
import { expectFields } from "./vectorCase.js";
import { readVector, verifyLive, type LiveCase } from "./liveReads.js";

// vectors/live-dns.json: the company domain's live DNS declaration, as the /verify page reads it.

const V = readVector<{
  defaultResolver: string;
  keyId: string;
  queryUrl: Array<{ resolver: string; domain: string; url: string }>;
  statusOf: Array<{ name: string; body: unknown; expect: string }>;
  cases: Array<Omit<LiveCase, "file" | "documents" | "issuerDocument">>;
}>("live-dns.json");

const caseOf = (c: Omit<LiveCase, "file" | "documents" | "issuerDocument">): LiveCase => ({
  ...c,
  file: "receipts/a3v4.bundle.json",
  documents: "receipts/v4-did-documents.json",
  issuerDocument: null,
});

describe("live-dns.json", () => {
  it("the default resolver is the one /verify asks", () => {
    expect(DEFAULT_DOH_URL).toBe(V.defaultResolver);
  });

  it.each(V.queryUrl.map((c) => [c.url, c] as const))("queryUrl %s", (_n, c) => {
    expect(liveDnsQueryUrl(c.resolver, c.domain)).toBe(c.url);
  });

  it.each(V.statusOf.map((c) => [c.name, c] as const))("statusOf: %s", (_n, c) => {
    expect(liveDnsStatusOf(c.body, V.keyId)).toBe(c.expect);
  });

  it.each(V.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const { result, asked } = await verifyLive(caseOf(c));
    expectFields(result, c.expect);
    expect(asked).toEqual(c.asked);
  });

  it("asks the resolver for its JSON form, which it refuses to a plain JSON accept", async () => {
    const c = V.cases.find((x) => x.asked.length === 1)!;
    const { headers } = await verifyLive(caseOf(c));
    expect(headers[0]!.get("accept")).toBe("application/dns-json");
  });
});
