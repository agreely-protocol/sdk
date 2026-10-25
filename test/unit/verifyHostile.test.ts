import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely, isVerificationBundle } from "../../src/index.js";
import type { DidDocument, ReceiptVerification, VerifyReceiptOptions } from "../../src/verify/types.js";

// Hostile inputs from the re-QA of 0.6.0 (qa-ver1r2): a deep receipt, a forged did:web citizen (c6),
// bundle shape errors, unchecked top-level receipt keys, and an RPC that never answers.

function artefact(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../vectors/receipts/${name}.json`, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
}

const DID_DOCS = artefact("did-documents") as Record<string, DidDocument>;
const resolver = (did: string): DidDocument | null => DID_DOCS[did] ?? null;

async function verify(input: unknown, opts: VerifyReceiptOptions = {}): Promise<ReceiptVerification> {
  return Agreely.verifyReceipt(input, { resolver, ...opts });
}

function nested(depth: number): unknown {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

function receiptOf(bundle: Record<string, unknown>): Record<string, unknown> {
  return bundle["receipt"] as Record<string, unknown>;
}

const MALFORMED_WORDING = /MALFORMED: .*not evidence that it was altered/;

describe("a hostile receipt never throws (N9)", () => {
  it("a paper receipt with a member nested 3000 deep resolves malformed", async () => {
    const r = artefact("a3v3.receipt");
    (r["credentialSubject"] as Record<string, unknown>)["deep"] = nested(3000);
    const result = await verify(r);
    expect(result.overall).toBe("malformed");
    expect(result.notes.join("\n")).toMatch(MALFORMED_WORDING);
    expect(result.notes.join("\n")).toContain("nests deeper than 64 levels");
  });

  it("the same receipt under the depth bound still reaches the canonicalizer and never throws", async () => {
    const r = artefact("a3v3.receipt");
    (r["credentialSubject"] as Record<string, unknown>)["deep"] = nested(40);
    const result = await verify(r);
    expect(result.overall).not.toBe("verified");
    expect(result.companySignature).toBe("fail");
  });

  it("an offer nested 5000 deep inside a passkey bundle resolves malformed", async () => {
    const bundle = artefact("a1v1.bundle");
    (bundle["signedOffer"] as Record<string, unknown>)["deep"] = nested(5000);
    expect((await verify(bundle)).overall).toBe("malformed");
  });

  it("a number the canonicalizer refuses in a paper receipt is malformed, not a tamper", async () => {
    const r = artefact("a3v3.receipt");
    (r["credentialSubject"] as Record<string, unknown>)["n"] = 1;
    const result = await verify(r);
    expect(result.overall).toBe("malformed");
    expect(result.notes.join("\n")).toContain("cannot be canonicalized");
  });

  it("an IPFS body nested 3000 deep is a failed copy, never a throw", async () => {
    const bundle = artefact("cidv1.bundle");
    const fetchImpl = (async () => new Response(JSON.stringify({ disclosure: nested(3000) }))) as unknown as typeof fetch;
    const result = await verify(bundle, { verifyDisclosure: true, fetch: fetchImpl });
    expect(result.disclosureCopy).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("a resolved DID document whose verificationMethod holds a null is unavailable, never a throw", async () => {
    const result = await Agreely.verifyReceipt(artefact("a3v3.receipt"), { resolver: () => ({ verificationMethod: [null] }) as unknown as DidDocument });
    expect(result.companySignature).toBe("unavailable");
  });

  it("a resolver whose document throws when read still resolves, as malformed", async () => {
    const hostile = { verificationMethod: [{ get id(): string { throw new Error("boom"); } }] } as unknown as DidDocument;
    const result = await Agreely.verifyReceipt(artefact("a3v3.receipt"), { resolver: () => hostile });
    expect(result.overall).toBe("malformed");
    expect(result.notes.join("\n")).toContain("it could not be processed (Error)");
  });

  it.each([null, [], "a string", 7])("a non-object input (%j) is malformed", async (input) => {
    expect((await verify(input)).overall).toBe("malformed");
  });
});

describe("the citizen half accepts only did:agreely:citizen subjects (N10, vector c6)", () => {
  // did-documents.json carries the forger's own document, as a resolver that fetches any did:web would serve it.
  const evil = DID_DOCS["did:web:evil.example:clients:jean"]!;

  it("c6 is not verified when the resolver serves the forger's did:web document", async () => {
    const result = await verify(artefact("c6-web-subject.bundle"));
    expect(result.companySignature).toBe("pass");
    expect(result.citizenAssertion).toBe("unavailable");
    expect(result.overall).not.toBe("verified");
    expect(result.notes.join("\n")).toContain("is not an Agreely citizen DID");
  });

  it("c6 under the DEFAULT resolver never fetches the subject's host and is not verified", async () => {
    const issuerDid = String(receiptOf(artefact("a1v1.bundle"))["issuer"]);
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://app.agreely.ca/c/showcase-assurance-boreale/did.json") return new Response(JSON.stringify(DID_DOCS[issuerDid]));
      if (url === "https://evil.example/clients/jean/did.json") return new Response(JSON.stringify(evil));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const result = await Agreely.verifyReceipt(artefact("c6-web-subject.bundle"), { fetch: fetchImpl });
    expect(result.citizenAssertion).toBe("unavailable");
    expect(result.overall).toBe("unavailable");
    expect(seen.some((u) => u.includes("evil.example"))).toBe(false);
  });

  it("a genuine did:agreely:citizen bundle still verifies under the default resolver, at the citizen tier", async () => {
    const bundle = artefact("a1v1.bundle");
    const issuerDid = String(receiptOf(bundle)["issuer"]);
    const citizenDid = String((receiptOf(bundle)["credentialSubject"] as Record<string, unknown>)["id"]);
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url === "https://app.agreely.ca/c/showcase-assurance-boreale/did.json") return new Response(JSON.stringify(DID_DOCS[issuerDid]));
      if (url === `https://my.agreely.ca/did/${encodeURIComponent(citizenDid)}`) return new Response(JSON.stringify(DID_DOCS[citizenDid]));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    expect((await Agreely.verifyReceipt(bundle, { fetch: fetchImpl })).overall).toBe("verified");
  });
});

describe("the bundle shape (R7, R8, R9)", () => {
  it.each([
    ["a number", 1],
    ["another version", "99"],
    ["no version", undefined],
  ])("a bundle whose version is %s is malformed, never verified", async (_label, version) => {
    const bundle = artefact("a1v1.bundle");
    if (version === undefined) delete bundle["version"];
    else bundle["version"] = version;
    expect(isVerificationBundle(bundle)).toBe(false);
    const result = await verify(bundle);
    expect(result.overall).toBe("malformed");
    expect(result.input).toBe("bundle");
  });

  it("an extra top-level key, type included, does not make a bundle a bare receipt", async () => {
    const bundle = artefact("a1v1.bundle");
    bundle["type"] = "AgreelyVerificationBundle";
    bundle["anything"] = { x: "y" };
    expect(isVerificationBundle(bundle)).toBe(true);
    const result = await verify(bundle);
    expect(result.input).toBe("bundle");
    expect(result.overall).toBe("verified");
  });

  it.each([
    ["a receipt that is an array", (b: Record<string, unknown>) => (b["receipt"] = [b["receipt"]])],
    ["a null receipt", (b: Record<string, unknown>) => (b["receipt"] = null)],
    ["a signedOffer that is a string", (b: Record<string, unknown>) => (b["signedOffer"] = "offer")],
    ["no signedOffer on a passkey receipt", (b: Record<string, unknown>) => delete b["signedOffer"]],
    ["no merkleRoot on a passkey receipt", (b: Record<string, unknown>) => delete b["merkleRoot"]],
  ])("%s is malformed with its own note, never worded as a tamper", async (_label, mutate) => {
    const bundle = artefact("a1v1.bundle");
    mutate(bundle);
    const result = await verify(bundle);
    expect(result.overall).toBe("malformed");
    const notes = result.notes.join("\n");
    expect(notes).toMatch(MALFORMED_WORDING);
    expect(notes).not.toMatch(/tamper|altered after/i);
  });

  it("a recorded receipt's bundle, which carries no signedOffer, is still a bundle", async () => {
    expect(isVerificationBundle(artefact("a3v3.bundle"))).toBe(true);
    expect((await verify(artefact("a3v3.bundle"))).overall).toBe("verified");
  });
});

describe("top-level receipt keys in a passkey bundle (R6)", () => {
  it.each([
    ["an extra top-level key", (r: Record<string, unknown>) => (r["extraTop"] = { claim: "x" })],
    ["a changed type", (r: Record<string, unknown>) => (r["type"] = ["VerifiableCredential", "ConsentReceipt", "Extra"])],
    ["a changed @context", (r: Record<string, unknown>) => (r["@context"] = ["https://evil.example/ctx"])],
    ["an id that is not a receipt urn", (r: Record<string, unknown>) => (r["id"] = "https://evil.example/receipt")],
  ])("%s fails receipt integrity", async (_label, mutate) => {
    const bundle = artefact("a1v1.bundle");
    mutate(receiptOf(bundle));
    const result = await verify(bundle);
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("the pass note no longer claims every field of the receipt is signed", async () => {
    const notes = (await verify(artefact("a1v1.bundle"))).notes.join("\n");
    expect(notes).not.toContain("every field of the receipt matches");
    expect(notes).toContain("The receipt id is not covered by the offer.");
  });
});

/** A JSON-RPC endpoint that answers `answer(method)`, or never answers when `answer` returns "hang". */
function rpcFetch(answer: (method: string) => unknown): { fetch: typeof fetch; calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const impl = (async (_input: string | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(req);
    const out = answer(req.method);
    if (out === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: out }));
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("Base Sepolia's deploy block (R11)", () => {
  it("the document-anchor log query on chain 84532 starts at block 43698609", async () => {
    const rpc = rpcFetch((m) => (m === "eth_blockNumber" ? "0x" + (43698609 + 5000).toString(16) : [{ blockNumber: "0x1" }]));
    await verify(artefact("cidv1.bundle"), { rpcUrl: "https://rpc.test", chainId: 84532, fetch: rpc.fetch });
    const logs = rpc.calls.find((c) => c.method === "eth_getLogs")!;
    expect((logs.params[0] as { fromBlock: string }).fromBlock).toBe("0x" + (43698609).toString(16));
  });
});

describe("an overall deadline on the RPC sequence (R13)", () => {
  it("an RPC that never answers cannot hold a verification past rpcDeadlineMs", async () => {
    const rpc = rpcFetch(() => "hang");
    const started = Date.now();
    const result = await verify(artefact("cidv1.bundle"), { rpcUrl: "https://rpc.test", fetch: rpc.fetch, rpcDeadlineMs: 300 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.overall).toBe("verified");
    // The first call hangs to the deadline; every call after it is refused without a request.
    expect(rpc.calls).toHaveLength(1);
  });
});
