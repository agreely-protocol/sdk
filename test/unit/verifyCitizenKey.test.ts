import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { canonicalize } from "../../src/crypto/jcs.js";
import type { DidDocument, ReceiptVerification, VerifyReceiptOptions } from "../../src/verify/types.js";
import { testIssuer } from "./signing.js";
import { A1V1_ANCHORED_AT, KEY_IN_FORCE, anchorBatchLog, anchorWord, chainFetch, onReadableRegistry } from "./registry.js";

// The citizen-key rule of the web verifier (citizen-key.js), the offer window, and a partial consent-anchor read.
// The crafted citizen documents are QA's (qa-ver1r3): one bundle, re-signed on the citizen side with a passkey of
// QA's own, read against each document the citizen tier might serve.

function vectorFile(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8")) as Record<
    string,
    unknown
  >;
}

const { citizenKey } = vectorFile("vectors.json") as {
  citizenKey: {
    didDocuments: string;
    cases: Array<{ name: string; file: string; citizenDocument: string | null; expect: ReceiptVerification }>;
  };
};
const DOCS = vectorFile(citizenKey.didDocuments) as { issuer: DidDocument; citizen: Record<string, DidDocument> };
const ISSUER = DOCS.issuer.id!;

function resolverFor(citizenDocument: string | null, issuerDoc: DidDocument = DOCS.issuer) {
  return (did: string): DidDocument | null =>
    did === ISSUER ? issuerDoc : citizenDocument === null ? null : (DOCS.citizen[citizenDocument] ?? null);
}

async function verify(input: unknown, opts: VerifyReceiptOptions): Promise<ReceiptVerification> {
  return Agreely.verifyReceipt(input, opts);
}

describe("the citizen-key rule (golden vectors, byte-identical across SDKs)", () => {
  for (const c of citizenKey.cases) {
    it(c.name, async () => {
      const result = await verify(vectorFile(c.file), { resolver: resolverFor(c.citizenDocument) });
      expect(canonicalize(result as unknown)).toBe(canonicalize(c.expect));
    });
  }
});

describe("a key the person's DID document does not confirm is never verified", () => {
  const thz = () => vectorFile("receipts/ck-thz.bundle.json");

  it.each([
    ["d02-notauth", "failed"],
    ["d03-idother", "unavailable"],
    ["d06-until-eq", "failed"],
    ["d07-from-after", "failed"],
    ["d10-otherbase", "failed"],
    ["d16-nofrom", "failed"],
    ["d18-rotated-before", "failed"],
  ])("%s reads %s, and no note says the person's passkey signed", async (doc, overall) => {
    const result = await verify(thz(), { resolver: resolverFor(doc) });
    expect(result.overall).toBe(overall);
    expect(result.citizenAssertion).toBe(overall === "failed" ? "fail" : "unavailable");
    expect(result.notes.join("\n")).not.toMatch(/verified and bound|lists that key under authentication/);
  });

  it("the same bundle verifies once the document lists the key in its window", async () => {
    const result = await verify(thz(), { resolver: resolverFor("d01-positive") });
    expect(result.overall).toBe("verified");
    expect(result.notes.join("\n")).toContain("lists that key under authentication, valid at grantedAt");
  });

  it("a grantedAt the passkey signed but that is not a date never confirms the key", async () => {
    const result = await verify(vectorFile("receipts/ck-w7-badgranted.bundle.json"), { resolver: resolverFor("w7-badgranted") });
    expect(result.citizenAssertion).toBe("unavailable");
    expect(result.overall).toBe("failed");
    expect(result.notes.join("\n")).toContain("Receipt integrity FAILED (offer-window-unreadable)");

    const noWindow = await withOffer({ createdAt: undefined }, "receipts/ck-w7-badgranted.bundle.json", "w7-badgranted");
    expect(noWindow.citizenAssertion).toBe("fail");
    expect(noWindow.notes.join("\n")).toContain("grantedAt is not a readable date, so no validity window");
  });

  it("a backdated receipt leaves the person's key not evaluated and says one thing of its integrity", async () => {
    const result = await verify(vectorFile("receipts/ck-b1-backdate.bundle.json"), { resolver: resolverFor("b1-backdate") });
    expect(result.companySignature).toBe("pass");
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.citizenAssertion).toBe("unavailable");
    expect(result.overall).toBe("failed");
    const notes = result.notes.join("\n");
    expect(notes).toContain("so the person's key is not evaluated at that date");
    expect(notes).not.toMatch(/verified and bound|lists that key under authentication/);
    expect(result.notes.filter((n) => n.startsWith("Receipt integrity"))).toHaveLength(1);
  });

  it.each([["did:agreely:citizen:.."], ["did:agreely:citizen:."]])("the subject %s is not looked up", async (subject) => {
    const bundle = vectorFile("receipts/ck-thz.bundle.json");
    ((bundle["receipt"] as Record<string, unknown>)["credentialSubject"] as Record<string, unknown>)["id"] = subject;
    const asked: string[] = [];
    const resolve = resolverFor("d01-positive");
    const result = await verify(bundle, { resolver: (did) => (asked.push(did), resolve(did)) });
    expect(result.citizenAssertion).toBe("unavailable");
    expect(asked).not.toContain(subject);
    expect(result.notes.join("\n")).toContain("is not an Agreely citizen DID");
  });

  it.each([
    ["receipt.proof keyed \"0\", \"1\"", (r: Record<string, unknown>) => (r["proof"] = { ...(r["proof"] as unknown[]) }), "companySignature"],
    [
      "consent.items keyed \"0\"",
      (r: Record<string, unknown>) => {
        const consent = (r["credentialSubject"] as Record<string, Record<string, unknown>>)["consent"]!;
        consent["items"] = { ...(consent["items"] as unknown[]) };
      },
      "receiptIntegrity",
    ],
  ] as const)("a bundle whose %s is an object fails", async (_label, mutate, check) => {
    const bundle = vectorFile("receipts/ck-thz.bundle.json");
    mutate(bundle["receipt"] as Record<string, unknown>);
    const result = await verify(bundle, { resolver: resolverFor("d01-positive") });
    expect(result[check]).toBe("fail");
    expect(result.overall).toBe("failed");
  });
});

// grantedAt of the crafted bundle is 2026-10-25T15:30:41Z. The offer is re-signed by a throwaway issuer under the
// same DID, which leaves the citizen challenge (it does not cover the offer's dates) intact.
async function withOffer(
  dates: Record<string, unknown>,
  file = "receipts/ck-thz.bundle.json",
  citizenDocument = "d01-positive",
): Promise<ReceiptVerification> {
  const bundle = vectorFile(file);
  const offer = { ...(bundle["signedOffer"] as Record<string, unknown>) };
  for (const [k, v] of Object.entries(dates)) {
    if (v === undefined) delete offer[k];
    else offer[k] = v;
  }
  const company = testIssuer(ISSUER);
  const receipt = bundle["receipt"] as Record<string, unknown>;
  const issuerProof = company.proofOver(offer);
  // The issuer writes proof[0].created from the offer's createdAt, and the verifier holds the two equal.
  if (typeof offer["createdAt"] === "string") issuerProof["created"] = offer["createdAt"];
  receipt["proof"] = [issuerProof, (receipt["proof"] as unknown[])[1]];
  bundle["signedOffer"] = offer;
  return verify(bundle, { resolver: resolverFor(citizenDocument, company.didDoc) });
}

describe("a bound grantedAt lies inside the company-signed offer (whole seconds)", () => {
  it.each([
    ["created one second after grantedAt", { createdAt: "2026-10-25T15:30:42Z" }],
    ["with an unreadable createdAt", { createdAt: "yesterday" }],
  ])("an offer %s leaves the person's key not evaluated", async (_label, dates) => {
    const result = await withOffer(dates);
    expect(result.citizenAssertion).toBe("unavailable");
    expect(result.companySignature).toBe("pass");
    expect(result.notes.join("\n")).not.toMatch(/verified and bound|lists that key under authentication/);
  });

  it.each([
    ["created at grantedAt", { createdAt: "2026-10-25T15:30:41Z" }],
    ["created within the same second", { createdAt: "2026-10-25T15:30:41.900Z" }],
    ["expiring at grantedAt", { expiresAt: "2026-10-25T15:30:41Z" }],
    ["expiring in the same second", { expiresAt: "2026-10-25T15:30:41.100Z" }],
    ["dated in another zone", { createdAt: "2026-10-25T11:30:41-04:00" }],
  ])("an offer %s verifies", async (_label, dates) => {
    const result = await withOffer(dates);
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.overall).toBe("verified");
  });

  it.each([
    ["created one second after grantedAt", { createdAt: "2026-10-25T15:30:42Z" }, "granted-outside-offer-window"],
    ["expired one second before grantedAt", { expiresAt: "2026-10-25T15:30:40Z" }, "granted-outside-offer-window"],
    ["with an unreadable createdAt", { createdAt: "yesterday" }, "offer-window-unreadable"],
    ["with an impossible expiresAt", { expiresAt: "2026-02-30T00:00:00Z" }, "offer-window-unreadable"],
  ])("an offer %s fails", async (_label, dates, code) => {
    const result = await withOffer(dates);
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.cellLabelBinding).toBe("pass");
    expect(result.overall).toBe("failed");
    expect(result.notes.join("\n")).toContain(`Receipt integrity FAILED (${code})`);
  });

  it.each([
    ["no createdAt", { createdAt: undefined }],
    ["no expiresAt", { expiresAt: undefined }],
  ])("an offer with %s gives no window verdict", async (_label, dates) => {
    const result = await withOffer(dates);
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.overall).toBe("verified");
  });

  it("is not judged when the company signature does not hold", async () => {
    const bundle = vectorFile("receipts/ck-b1-backdate.bundle.json");
    const result = await verify(bundle, { resolver: (did) => (did === ISSUER ? null : DOCS.citizen["b1-backdate"]!) });
    expect(result.companySignature).toBe("unavailable");
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.overall).toBe("unavailable");
  });
});

describe("a partial consent-anchor read is unavailable, never pass", () => {
  it("one cell answered under the bundle's root and another unreadable reads unavailable", async () => {
    const bundle = onReadableRegistry(vectorFile("receipts/a1v1.bundle.json"));
    const docs = vectorFile("receipts/did-documents.json") as Record<string, DidDocument>;
    const root = String(bundle["merkleRoot"]).replace(/^0x/, "");
    let calls = 0;
    const rpc = chainFetch({
      registry: () => (++calls > 1 ? new Response("down", { status: 503 }) : anchorWord(root, A1V1_ANCHORED_AT)),
      companyKeyOf: () => KEY_IN_FORCE,
      logs: () => [anchorBatchLog(root, 3)],
    });
    const result = await verify(bundle, { resolver: (did) => docs[did] ?? null, rpcUrl: "https://rpc.test", chainId: 84532, fetch: rpc.fetch });
    expect(calls).toBe(3);
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.notes.join("\n")).toContain("1 active, 0 withdrawn, 0 not anchored yet, 2 unreadable");
  });
});

describe("the consent anchor passes only once every cell is recorded under the bundle's root", () => {
  it.each([
    [1, "unavailable", "1 active, 0 withdrawn, 2 not anchored yet, 0 unreadable"],
    [3, "pass", "3 active, 0 withdrawn, 0 not anchored yet, 0 unreadable"],
  ])("%i of 3 cells anchored reads %s", async (anchored, status, counts) => {
    const bundle = onReadableRegistry(vectorFile("receipts/a1v1.bundle.json"));
    const docs = vectorFile("receipts/did-documents.json") as Record<string, DidDocument>;
    const root = String(bundle["merkleRoot"]).replace(/^0x/, "");
    let calls = 0;
    const rpc = chainFetch({
      registry: () => (++calls <= anchored ? anchorWord(root, A1V1_ANCHORED_AT) : anchorWord("0x" + "00".repeat(32), 0, 0, 0)),
      companyKeyOf: () => KEY_IN_FORCE,
      logs: () => [anchorBatchLog(root, 3)],
    });
    const result = await verify(bundle, { resolver: (did) => docs[did] ?? null, rpcUrl: "https://rpc.test", chainId: 84532, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe(status);
    expect(result.notes.join("\n")).toContain(counts);
  });
});
