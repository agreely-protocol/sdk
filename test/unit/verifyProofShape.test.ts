import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import type { DidDocument, ReceiptVerification } from "../../src/verify/types.js";

// No signature covers a proof's own members, so the verifier holds the proof array to the shape the issuer writes:
// a passkey receipt carries exactly the company's DataIntegrityProof then the person's WebAuthnAssertion, a paper or
// telephone receipt exactly the company's proof, each with exactly its issued members, all strings. The members the
// issuer copies from a signed value must equal it: a passkey proof[0].created is the offer's createdAt and proof[1].nonce
// its nonce, a recorded v2 to v4 proof[0].created is its recordedAt. A v1 recorded receipt pins nothing.

type Obj = Record<string, unknown>;

function vector(rel: string): Obj {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8")) as Obj;
}

const DOCS = vector("receipts/did-documents.json") as Record<string, DidDocument>;
const F12 = vector("receipts/f12-recovery-key.json") as { issuerDocument: DidDocument; genuine: Obj };
const V1_PAPER = (vector("vectors.json")["receiptVerification"] as { cases: Array<{ receipt: Obj }>; fixtures: { didDocuments: Record<string, DidDocument> } });

const proofsOf = (r: Obj): Obj[] => r["proof"] as Obj[];
const receiptOf = (bundle: Obj): Obj => bundle["receipt"] as Obj;

function bundle(edit: (b: Obj) => void = () => {}): Obj {
  const b = vector("receipts/a1v1.bundle.json");
  edit(b);
  return b;
}

function paper(edit: (r: Obj) => void = () => {}): Obj {
  const r = structuredClone(F12.genuine);
  edit(r);
  return r;
}

const verifyBundle = (b: Obj): Promise<ReceiptVerification> =>
  Agreely.verifyReceipt(b, { resolver: (did) => DOCS[did] ?? null });

const verifyPaper = (r: Obj): Promise<ReceiptVerification> =>
  Agreely.verifyReceipt(r, { resolver: (did) => (did === r["issuer"] ? F12.issuerDocument : null) });

const integrityNote = (result: ReceiptVerification): string =>
  result.notes.find((n) => n.startsWith("Receipt integrity")) ?? "";

describe("a passkey bundle's proof array is held to its issued shape", () => {
  it("the genuine bundle verifies", async () => {
    const result = await verifyBundle(bundle());
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.overall).toBe("verified");
  });

  const malformed: Array<[string, (b: Obj) => void]> = [
    ["a third proof", (b) => proofsOf(receiptOf(b)).push(structuredClone(proofsOf(receiptOf(b))[0]!))],
    ["only the company proof", (b) => proofsOf(receiptOf(b)).splice(1, 1)],
    ["the two proofs swapped", (b) => proofsOf(receiptOf(b)).reverse()],
    ["an extra member on proof[0]", (b) => (proofsOf(receiptOf(b))[0]!["note"] = "x")],
    ["an extra member on proof[1]", (b) => (proofsOf(receiptOf(b))[1]!["note"] = "x")],
    ["a proof[0] member that is not a string", (b) => (proofsOf(receiptOf(b))[0]!["created"] = 1)],
    ["a proof[0] of another purpose", (b) => (proofsOf(receiptOf(b))[0]!["proofPurpose"] = "authentication")],
    ["a proof[1] under another DID", (b) => (proofsOf(receiptOf(b))[1]!["verificationMethod"] = "did:agreely:citizen:other#passkey-1")],
    ["a proof array that is an object", (b) => (receiptOf(b)["proof"] = { 0: proofsOf(receiptOf(b))[0], 1: proofsOf(receiptOf(b))[1] })],
  ];
  it.each(malformed)("%s FAILS its integrity", async (_label, edit) => {
    const result = await verifyBundle(bundle(edit));
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
    expect(integrityNote(result)).toContain("Receipt integrity FAILED: the proof array is not");
  });

  it("a proof[0].created moved off the offer's createdAt FAILS, the signatures intact", async () => {
    const result = await verifyBundle(bundle((b) => (proofsOf(receiptOf(b))[0]!["created"] = "2020-01-01T00:00:00Z")));
    expect(result.companySignature).toBe("pass");
    expect(result.citizenAssertion).toBe("pass");
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
    expect(integrityNote(result)).toBe("Receipt integrity FAILED: proof[0].created differs from the signed offer's createdAt.");
  });

  it("a proof[1].nonce moved off the offer's nonce FAILS", async () => {
    const result = await verifyBundle(bundle((b) => (proofsOf(receiptOf(b))[1]!["nonce"] = "0x" + "00".repeat(16))));
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
    expect(integrityNote(result)).toBe("Receipt integrity FAILED: proof[1].nonce differs from the signed offer's nonce.");
  });

  it("an offer without createdAt pins no created", async () => {
    const result = await verifyBundle(
      bundle((b) => {
        delete (b["signedOffer"] as Obj)["createdAt"];
        proofsOf(receiptOf(b))[0]!["created"] = "2020-01-01T00:00:00Z";
      }),
    );
    expect(integrityNote(result)).not.toContain("created");
  });
});

describe("a recorded receipt's proof array is held to its issued shape", () => {
  it("the genuine v3 paper receipt verifies", async () => {
    const result = await verifyPaper(paper());
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.overall).toBe("verified");
  });

  const malformed: Array<[string, (r: Obj) => void]> = [
    ["a second proof", (r) => proofsOf(r).push(structuredClone(proofsOf(r)[0]!))],
    ["no proof", (r) => (r["proof"] = [])],
    ["an extra member on proof[0]", (r) => (proofsOf(r)[0]!["note"] = "x")],
    ["a proof[0] of another type", (r) => (proofsOf(r)[0]!["type"] = "Ed25519Signature2020")],
  ];
  it.each(malformed)("%s FAILS its integrity", async (_label, edit) => {
    const result = await verifyPaper(paper(edit));
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("a v3 proof[0].created moved off recordedAt FAILS, the signature intact", async () => {
    const result = await verifyPaper(paper((r) => (proofsOf(r)[0]!["created"] = "2026-10-26T10:00:00Z")));
    expect(result.companySignature).toBe("pass");
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
    expect(integrityNote(result)).toBe("Receipt integrity FAILED: proof[0].created differs from the consent's recordedAt.");
  });

  it("the structure is refused offline: an unresolved issuer still reads failed", async () => {
    const result = await Agreely.verifyReceipt(paper((r) => proofsOf(r).push(structuredClone(proofsOf(r)[0]!))), {
      resolver: () => null,
    });
    expect(result.companySignature).toBe("unavailable");
    expect(result.overall).toBe("failed");
  });

  it("a v1 receipt pins no created", async () => {
    const r = V1_PAPER.cases[0]!.receipt;
    expect(r["receiptVersion"]).toBeUndefined();
    expect(proofsOf(r)[0]!["created"]).not.toBe((((r["credentialSubject"] as Obj)["consent"]) as Obj)["grantedAt"]);
    const result = await Agreely.verifyReceipt(r, { resolver: (did) => V1_PAPER.fixtures.didDocuments[did] ?? null });
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.overall).toBe("verified");
  });
});

describe("the person's assertion is read at proof[1] only", () => {
  it("a bare passkey receipt whose assertion sits at proof[2] reads no assertion", async () => {
    const r = vector("receipts/a1v1.receipt.json");
    proofsOf(r).splice(1, 0, structuredClone(proofsOf(r)[0]!));
    const result = await Agreely.verifyReceipt(r, { resolver: (did) => DOCS[did] ?? null });
    expect(result.citizenAssertion).toBe("fail");
    expect(result.notes).toContain("Citizen assertion FAILED: no WebAuthn assertion or citizen DID on the receipt.");
  });
});
