import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import type { DidDocument, ReceiptVerification } from "../../src/verify/types.js";
import { testIssuer } from "./signing.js";

// The key that checks proof[0] is the method the proof names, controlled by the issuer and listed under the issuer
// document's assertionMethod. The served document also lists #root-1 (capabilityDelegation) and #recovery-1
// (capabilityInvocation, a key the company holds): neither may check a receipt. A fragment naming no method falls
// back to the document's SOLE assertionMethod key, never the first method.
//
// f12-recovery-key.json: the a3v3 paper receipt (genuine), the same receipt backdated with another purpose and
// signed by a #recovery-1 key whose private half was discarded, and the document Agreely publishes for a company with
// a root and a recovery key. The same bytes are the web verifier's tests/js/fixtures/r748e-recovery-signed.json.

function vector(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../vectors/receipts/${name}.json`, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
}

const F12 = vector("f12-recovery-key") as {
  issuerDocument: DidDocument;
  recoverySigned: Record<string, unknown>;
  genuine: Record<string, unknown>;
};
const ISSUER = F12.genuine["issuer"] as string;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function labelled(receipt: Record<string, unknown>, fragment: string): Record<string, unknown> {
  const r = clone(receipt);
  (r["proof"] as Record<string, unknown>[])[0]!["verificationMethod"] = ISSUER + fragment;
  return r;
}

function recoveryFirst(): DidDocument {
  const doc = clone(F12.issuerDocument);
  doc.verificationMethod!.reverse();
  return doc;
}

async function verify(input: unknown, doc: DidDocument = F12.issuerDocument): Promise<ReceiptVerification> {
  return Agreely.verifyReceipt(input, { resolver: (did) => (did === ISSUER ? doc : null) });
}

const companyNote = (result: ReceiptVerification): string =>
  result.notes.find((n) => n.startsWith("Company signature")) ?? "";

describe("the company signature is checked only with a key listed under assertionMethod", () => {
  it("the genuine receipt verifies and the note names #kms-1", async () => {
    const result = await verify(F12.genuine);
    expect(result.companySignature).toBe("pass");
    expect(result.overall).toBe("verified");
    expect(companyNote(result)).toContain(`(key ${ISSUER}#kms-1)`);
  });

  it("a receipt signed with the #recovery-1 key FAILS", async () => {
    const result = await verify(F12.recoverySigned);
    expect(result.companySignature).toBe("fail");
    expect(result.overall).toBe("failed");
    expect(companyNote(result)).toContain("lists no Ed25519 key under assertionMethod");
  });

  it.each(["#recovery-1", "#root-1"])("a kms-1 signature labelled %s FAILS", async (fragment) => {
    const result = await verify(labelled(F12.genuine, fragment));
    expect(result.companySignature).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("a fragment naming no method falls back to the sole assertionMethod key and names THAT key", async () => {
    const result = await verify(labelled(F12.genuine, "#not-a-key"));
    expect(result.companySignature).toBe("pass");
    expect(companyNote(result)).toContain(`(key ${ISSUER}#kms-1)`);
    expect(result.notes.join("\n")).not.toContain("#not-a-key");
  });

  it("the fallback is never the first method: recovery listed first, a recovery signature under #not-a-key FAILS", async () => {
    const result = await verify(labelled(F12.recoverySigned, "#not-a-key"), recoveryFirst());
    expect(result.companySignature).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("a fragment naming no method FAILS when the document lists two assertionMethod keys", async () => {
    const doc = clone(F12.issuerDocument);
    doc["assertionMethod"] = [...(doc["assertionMethod"] as unknown[]), "#recovery-1"];
    const result = await verify(labelled(F12.genuine, "#not-a-key"), doc);
    expect(result.companySignature).toBe("fail");
  });

  it("an assertionMethod key controlled by another DID never checks the receipt", async () => {
    const doc = clone(F12.issuerDocument);
    doc.verificationMethod![0]!.controller = "did:web:elsewhere.example";
    const result = await verify(F12.genuine, doc);
    expect(result.companySignature).toBe("fail");
  });

  it("an issuer document that does not resolve stays unavailable, never a failure", async () => {
    const result = await Agreely.verifyReceipt(F12.recoverySigned, { resolver: () => null });
    expect(result.companySignature).toBe("unavailable");
  });

  it("a passkey bundle whose offer is signed with a #recovery-1 key FAILS its company signature", async () => {
    const docs = vector("did-documents") as Record<string, DidDocument>;
    const bundle = vector("a1v1.bundle");
    const receipt = bundle["receipt"] as Record<string, unknown>;
    const issuer = receipt["issuer"] as string;
    const recovery = testIssuer(issuer);
    const doc = clone(docs[issuer]!);
    doc.verificationMethod!.push({ ...recovery.didDoc.verificationMethod![0]!, id: issuer + "#recovery-1" });
    doc["capabilityInvocation"] = ["#recovery-1"];
    const proof = recovery.proofOver(bundle["signedOffer"]);
    proof["verificationMethod"] = issuer + "#recovery-1";
    (receipt["proof"] as Record<string, unknown>[])[0] = proof;
    const result = await Agreely.verifyReceipt(bundle, { resolver: (did) => (did === issuer ? doc : (docs[did] ?? null)) });
    expect(result.companySignature).toBe("fail");
    expect(result.overall).toBe("failed");
  });
});
