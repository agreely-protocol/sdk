import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely, isVerificationBundle } from "../../src/index.js";
import type { DidDocument, ReceiptVerification, VerifyReceiptOptions } from "../../src/verify/types.js";

// Real artefacts issued by the app (qa-ver1): genuine A1 passkey bundles, recorded A3 paper and A4 phone
// receipts, and the forgeries F1 to F11 that SDK 0.5.0 called "verified".

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

const FORGED = ["f1-purpose", "f2-granted", "f3-cell", "f4-graft-keepsubj", "f5-graft-subjX", "f6-doc", "f7-issuer", "f11-basis"];

describe("a forged artefact is never verified (N1)", () => {
  it.each(FORGED)("%s as a bundle FAILS", async (name) => {
    const result = await verify(artefact(`${name}.bundle`));
    expect(result.input).toBe("bundle");
    expect(result.overall).toBe("failed");
  });

  it.each(FORGED)("%s as a bare receipt is not verified", async (name) => {
    const result = await verify(artefact(`${name}.receipt`));
    expect(result.input).toBe("receipt");
    expect(result.overall).not.toBe("verified");
    expect(["incomplete", "failed"]).toContain(result.overall);
  });

  it("a forged paper (F8) and a forged phone (F9) receipt FAIL", async () => {
    expect((await verify(artefact("f8-paper.receipt"))).overall).toBe("failed");
    expect((await verify(artefact("f9-phone.receipt"))).overall).toBe("failed");
  });

  it("a self-signed bundle (F10) FAILS: keys come from the resolver, never from the bundle's own didDocuments", async () => {
    const result = await verify(artefact("f10-selfsigned-paper.bundle"));
    expect(result.companySignature).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("a passkey assertion grafted from another consent (F4, F5) is refused inside a bundle", async () => {
    for (const name of ["f4-graft-keepsubj", "f5-graft-subjX"]) {
      const result = await verify(artefact(`${name}.bundle`));
      expect(result.citizenAssertion).toBe("fail");
    }
  });

  it("no note claims a committed challenge", async () => {
    for (const name of ["a1v1.bundle", "a1v1.receipt", "f1-purpose.receipt", "f4-graft-keepsubj.receipt"]) {
      expect((await verify(artefact(name))).notes.join("\n")).not.toMatch(/committed challenge/i);
    }
  });
});

describe("a genuine artefact verifies", () => {
  it.each(["a1v1", "a1v2"])("the genuine %s passkey bundle is verified", async (name) => {
    const result = await verify(artefact(`${name}.bundle`));
    expect(result).toMatchObject({
      input: "bundle",
      companySignature: "pass",
      receiptIntegrity: "pass",
      citizenAssertion: "pass",
      overall: "verified",
    });
  });

  it.each(["a1v1", "a1v2"])("the genuine bare %s receipt is unbound and incomplete, and says to verify the bundle", async (name) => {
    const result = await verify(artefact(`${name}.receipt`));
    expect(result.citizenAssertion).toBe("unbound");
    expect(result.overall).toBe("incomplete");
    expect(result.notes.join("\n")).toContain("Verify the verification bundle");
  });

  it("a recorded paper receipt (A3) verifies bare and wrapped, and a phone receipt (A4) is documented, never tampered", async () => {
    expect((await verify(artefact("a3v3.receipt"))).overall).toBe("verified");
    expect((await verify(artefact("a3v2.receipt"))).overall).toBe("verified");
    expect((await verify(artefact("a3v3.bundle"))).overall).toBe("verified");
    for (const name of ["a4v3.receipt", "a4v2.receipt", "a4v3.bundle"]) {
      const result = await verify(artefact(name));
      expect(result.overall).toBe("partial");
      expect(result.companySignature).toBe("pass");
    }
  });
});

describe("a bundle is detected (N4)", () => {
  it("isVerificationBundle tells a bundle from a receipt", () => {
    expect(isVerificationBundle(artefact("a1v1.bundle"))).toBe(true);
    expect(isVerificationBundle(artefact("a3v3.bundle"))).toBe(true);
    expect(isVerificationBundle(artefact("a1v1.receipt"))).toBe(false);
    expect(isVerificationBundle(artefact("a3v3.receipt"))).toBe(false);
    expect(isVerificationBundle(null)).toBe(false);
  });

  it("a passkey bundle stripped of its signed offer is malformed, never verified", async () => {
    const bundle = artefact("a1v1.bundle");
    delete bundle["signedOffer"];
    const result = await verify(bundle);
    expect(result.input).toBe("bundle");
    expect(result.overall).toBe("malformed");
  });
});

/** A JSON-RPC endpoint: `answer` maps a method to its result, or returns a Response or throws. */
function rpcFetch(answer: (method: string, params: unknown[]) => unknown): { fetch: typeof fetch; calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const impl = (async (_input: string | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(req);
    const out = answer(req.method, req.params);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: out }), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const HEAD = 48889369 + 25000;
const hexBlock = (n: number) => "0x" + n.toString(16);

describe("the document anchor is bounded and best-effort (N6)", () => {
  const cidBundle = () => artefact("cidv1.bundle");

  it.each([
    ["a JSON-RPC error", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }))],
    ["an HTTP 503", () => new Response("down", { status: 503 })],
    ["a network failure", () => {
      throw new TypeError("fetch failed");
    }],
  ])("%s reads unavailable, never failed", async (_label, fail) => {
    const rpc = rpcFetch(() => fail());
    const result = await verify(cidBundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.overall).not.toBe("failed");
  });

  it("queries from the deploy block, never from block 0", async () => {
    const rpc = rpcFetch((m) => (m === "eth_blockNumber" ? hexBlock(HEAD) : [{ blockNumber: "0x1" }]));
    const result = await verify(cidBundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("pass");
    const logs = rpc.calls.filter((c) => c.method === "eth_getLogs");
    expect((logs[0]!.params[0] as { fromBlock: string }).fromBlock).toBe(hexBlock(48889369));
  });

  it("a refused full range pages backwards within the limit, and an empty answer over the whole range FAILS", async () => {
    const rpc = rpcFetch((m, params) => {
      if (m === "eth_blockNumber") return hexBlock(HEAD);
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      if (parseInt(toBlock, 16) - parseInt(fromBlock, 16) + 1 > 10000) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "range too large" } }));
      }
      return [];
    });
    const result = await verify(cidBundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("fail");
    expect(rpc.calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(1 + 3);
  });

  it("a range larger than the query budget is unavailable, not a missing anchor", async () => {
    const rpc = rpcFetch((m, params) => {
      if (m === "eth_blockNumber") return hexBlock(HEAD);
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      if (parseInt(toBlock, 16) - parseInt(fromBlock, 16) + 1 > 10000) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "range too large" } }));
      }
      return [];
    });
    const result = await verify(cidBundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch, maxLogQueries: 2 });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.overall).not.toBe("failed");
  });
});

/** The packed `struct Anchor` (merkleRoot, anchoredAt, revokedAt, state) as eth_call returns it. */
function anchorWord(root: string, anchoredAt: number, revokedAt = 0, state = 1): string {
  const w = (n: number) => n.toString(16).padStart(64, "0");
  return "0x" + root.replace(/^0x/, "") + w(anchoredAt) + w(revokedAt) + w(state);
}

describe("the consent anchor is read with eth_call registry(consentRef) (N6)", () => {
  const bundle = () => artefact("a1v1.bundle");
  const root = () => String(bundle()["merkleRoot"]);

  it("a record under the bundle's Merkle root passes, read with the registry(bytes32) selector", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord(root(), 1760000000) : null));
    const result = await verify(bundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("pass");
    expect(result.overall).toBe("verified");
    const call = rpc.calls.find((c) => c.method === "eth_call")!;
    const refs = bundle()["consentRefs"] as string[];
    expect((call.params[0] as { data: string }).data).toBe("0x7ef50298" + refs[0]!.slice(2));
    expect(rpc.calls.some((c) => c.method === "eth_getLogs")).toBe(false);
  });

  it("a record under another Merkle root FAILS", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord("0x" + "99".repeat(32), 1760000000) : null));
    const result = await verify(bundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("an RPC error or a record not anchored yet is unavailable, never failed", async () => {
    const down = rpcFetch(() => new Response("down", { status: 502 }));
    const pending = rpcFetch((m) => (m === "eth_call" ? anchorWord("0x" + "00".repeat(32), 0, 0, 0) : null));
    for (const rpc of [down, pending]) {
      const result = await verify(bundle(), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
      expect(result.consentAnchor).toBe("unavailable");
      expect(result.overall).not.toBe("failed");
    }
  });

  it("is never read for a bare receipt, whose Merkle root nothing binds", async () => {
    const rpc = rpcFetch(() => null);
    const result = await verify(artefact("a1v1.receipt"), { rpcUrl: "https://rpc.test", fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("skipped");
    expect(rpc.calls.some((c) => c.method === "eth_call")).toBe(false);
  });
});
