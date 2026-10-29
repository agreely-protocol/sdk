import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { recordedShapeOf } from "../../src/verify/recorded.js";
import type { DidDocument } from "../../src/verify/types.js";
import { vectorChainFetch, type VectorAnswers } from "./registry.js";
import { expectFields } from "./vectorCase.js";

// vectors/recorded-v4.json: a version 4 paper or telephone receipt signs its anchor batch; the chain is read on the
// SIGNED refs, and only once companyKeyOf confirms the company key at the signing instant.

const read = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8")) as T;

const V4 = read<{
  signedRefs: string[];
  cases: Array<{ name: string; file: string; answers: VectorAnswers | null; expect: Record<string, unknown> & { readRefs?: string[] } }>;
}>("recorded-v4.json");
const DOCS = read<Record<string, DidDocument>>("receipts/v4-did-documents.json");

describe("recorded-v4.json", () => {
  it.each(V4.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const rpc = vectorChainFetch(c.answers ?? {});
    const result = await Agreely.verifyReceipt(read(c.file), {
      resolver: (did) => DOCS[did] ?? null,
      ...(c.answers !== null ? { rpcUrl: "https://rpc.test", chainId: 84532, fetch: rpc.fetch } : {}),
    });
    expectFields(result, c.expect);
    if (c.expect.readRefs !== undefined) expect(rpc.refs).toEqual(c.expect.readRefs);
    if (c.answers === null) expect(rpc.calls).toHaveLength(0);
  });
});

describe("the members each recorded version writes", () => {
  const a3 = (): Record<string, unknown> => structuredClone((read<{ receipt: Record<string, unknown> }>("receipts/a3v4.bundle.json")).receipt);
  const consentOf = (r: Record<string, unknown>) => (r["credentialSubject"] as { consent: Record<string, unknown> }).consent;

  it("a version 4 with its anchor is the issuer's shape", () => {
    expect(recordedShapeOf(a3(), "company_attested")).toEqual({ kind: "ok" });
  });

  it("a version 3 never carries an anchor; a version 2 never carries a declaration", () => {
    const v3 = a3();
    v3["receiptVersion"] = "3";
    expect(recordedShapeOf(v3, "company_attested").kind).toBe("mismatch");
    delete consentOf(v3)["merkleRoot"];
    delete consentOf(v3)["consentRefs"];
    expect(recordedShapeOf(v3, "company_attested")).toEqual({ kind: "ok" });
    const v2 = structuredClone(v3);
    v2["receiptVersion"] = "2";
    consentOf(v2)["issuerDeclaration"] = {};
    expect(recordedShapeOf(v2, "company_attested").kind).toBe("mismatch");
  });

  it("a receipt with no receiptVersion carries no member a later version writes", () => {
    const v1 = a3();
    delete v1["receiptVersion"];
    expect(recordedShapeOf(v1, "company_attested").kind).toBe("mismatch");
    for (const k of ["recordedAt", "issuerDeclaration", "merkleRoot", "consentRefs"]) delete consentOf(v1)[k];
    expect(recordedShapeOf(v1, "company_attested")).toEqual({ kind: "ok" });
  });

  it("a version this verifier does not read is named, never guessed", () => {
    const v5 = a3();
    v5["receiptVersion"] = "5";
    expect(recordedShapeOf(v5, "company_attested")).toEqual({ kind: "unknown-version", version: "5" });
  });
});
