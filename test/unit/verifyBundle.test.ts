import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely, isVerificationBundle } from "../../src/index.js";
import type { DidDocument, ReceiptVerification, VerifyReceiptOptions } from "../../src/verify/types.js";
import { MAINNET_REGISTRY, SEPOLIA_REGISTRY, anchorWord, onReadableRegistry, rootWord } from "./registry.js";

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

const SEPOLIA = { rpcUrl: "https://rpc.test", chainId: 84532 };

describe("the document anchor is one eth_call rootOf(keccak256(cid)) (N6)", () => {
  const cidBundle = () => onReadableRegistry(artefact("cidv1.bundle"));

  it.each([
    ["a JSON-RPC error", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }))],
    ["an HTTP 503", () => new Response("down", { status: 503 })],
    ["a network failure", () => {
      throw new TypeError("fetch failed");
    }],
    ["a short answer", () => "0x" + "00".repeat(96)],
  ])("%s reads unavailable, never failed", async (_label, fail) => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? fail() : null));
    const result = await verify(cidBundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.overall).not.toBe("failed");
  });

  it("a lane-3 record passes, in one call and with no log query", async () => {
    const rpc = rpcFetch((m, params) => {
      const data = (params[0] as { data: string }).data;
      return m === "eth_call" && data.startsWith("0x6d6f398e") ? rootWord(3) : null;
    });
    const result = await verify(cidBundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("pass");
    expect(result.documentAnchorRecord).toEqual({ anchoredAt: 1790816400, anchoredBlock: 53000000 });
    expect(rpc.calls.filter((c) => c.method !== "eth_call")).toHaveLength(0);
  });

  it("an absent record is UNAVAILABLE, not fail, and leaves a verified bundle verified (R13)", async () => {
    const rpc = rpcFetch((m, params) => (m === "eth_call" && (params[0] as { data: string }).data.startsWith("0x6d6f398e") ? rootWord(0) : null));
    const result = await verify(cidBundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.overall).toBe("verified");
  });
});

describe("a bundle naming a registry the SDK does not read is refused, with no RPC", () => {
  // The vectors were issued on the emit-only Base Sepolia registry, named in their signed issuer delegation.
  const EMIT_ONLY = ["0x3532a9DfF3C910152543afCa49De7c66113C5312", "0x23577fafFa306375028D33a559D0F95Ced9424DB"];

  it.each(EMIT_ONLY)("a bundle naming %s reads both anchor checks unavailable as an unknown registry, never verified", async (address) => {
    const named = structuredClone(artefact("a1v1.bundle")) as { didDocuments: { issuer: { delegation: { body: Record<string, unknown> } } } };
    named.didDocuments.issuer.delegation.body["registry"] = address.toLowerCase();
    const rpc = rpcFetch(() => rootWord(3));
    const result = await verify(named, { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.overall).toBe("unavailable");
    expect(result.notes.join("\n")).toContain(`unknown registry: the bundle names the registry ${address.toLowerCase()} on chainId 84532, which is not a known registry for chainId 84532`);
    expect(rpc.calls).toHaveLength(0);
  });

  it("a cidv1 bundle naming the emit-only registry reads its document anchor unavailable, with no RPC", async () => {
    const named = structuredClone(artefact("cidv1.bundle")) as { didDocuments: { issuer: { delegation: { body: Record<string, unknown> } } } };
    named.didDocuments.issuer.delegation.body["registry"] = EMIT_ONLY[0]!.toLowerCase();
    const rpc = rpcFetch(() => rootWord(3));
    const result = await verify(named, { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.overall).not.toBe("verified");
    expect(rpc.calls).toHaveLength(0);
  });

  it("the issued vectors keep their signatures and structure, and their anchor step refuses the registry they name", async () => {
    for (const name of ["a1v1.bundle", "cidv1.bundle"]) {
      const rpc = rpcFetch(() => rootWord(3));
      const result = await verify(artefact(name), { ...SEPOLIA, fetch: rpc.fetch });
      expect([result.companySignature, result.receiptIntegrity, result.citizenAssertion]).toEqual(["pass", "pass", "pass"]);
      expect(result.consentAnchor).toBe("unavailable");
      expect(result.overall).toBe("unavailable");
      expect(result.documentAnchor).not.toBe("pass");
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("a bundle naming the registry it is read on, but another chain, is refused", async () => {
    const named = onReadableRegistry(artefact("a1v1.bundle")) as { didDocuments: { issuer: { delegation: { body: Record<string, unknown> } } } };
    named.didDocuments.issuer.delegation.body["chainId"] = "8453";
    const rpc = rpcFetch(() => rootWord(3));
    const result = await verify(named, { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.overall).not.toBe("verified");
    expect(rpc.calls).toHaveLength(0);
  });
});

describe("the consent anchor is read with eth_call registry(consentRef) (N6)", () => {
  const bundle = () => onReadableRegistry(artefact("a1v1.bundle"));
  const root = () => String(bundle()["merkleRoot"]);

  it("a record under the bundle's Merkle root passes, read with the registry(bytes32) selector, its block exposed", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord(root(), 1760000000) : null));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("pass");
    expect(result.overall).toBe("verified");
    const call = rpc.calls.find((c) => c.method === "eth_call")!;
    const refs = bundle()["consentRefs"] as string[];
    expect((call.params[0] as { data: string; to: string }).data).toBe("0x7ef50298" + refs[0]!.slice(2));
    expect((call.params[0] as { to: string }).to).toBe(SEPOLIA_REGISTRY);
    expect(result.consentAnchorRecords).toHaveLength(refs.length);
    expect(result.consentAnchorRecords![0]).toEqual({
      consentRef: refs[0], state: "active", anchoredAt: 1760000000, revokedAt: 0, anchoredBlock: 53000000,
    });
    expect(result.notes.join("\n")).toContain("anchored in block 53000000");
  });

  it("a withdrawn record (state 2) is never a pass", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord(root(), 1760000000, 1760000600, 2) : null));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).not.toBe("pass");
    expect(result.consentAnchor).toBe("withdrawn");
    expect(result.consentAnchorRecords![0]!.state).toBe("withdrawn");
    expect(result.consentAnchorRecords![0]!.revokedAt).toBe(1760000600);
    expect(result.notes.join("\n")).toContain("WITHDRAWN");
    expect(result.notes.join("\n")).toContain("NOT a forgery");
  });

  it("an authentic withdrawn consent reads overall withdrawn, only when every other decisive check verified", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord(root(), 1760000000, 1760000600, 2) : null));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.companySignature).toBe("pass");
    expect(result.citizenAssertion).toBe("pass");
    expect(result.overall).toBe("withdrawn");
  });

  it("a withdrawn consent next to a failed document anchor is failed, not withdrawn", async () => {
    const bundleWithCid = onReadableRegistry(artefact("cidv1.bundle"));
    const cidRoot = String(bundleWithCid["merkleRoot"]);
    const rpc = rpcFetch((m, params) => {
      if (m !== "eth_call") return null;
      const data = (params[0] as { data: string }).data;
      return data.startsWith("0x6d6f398e") ? rootWord(1) : anchorWord(cidRoot, 1760000000, 1760000600, 2);
    });
    const result = await verify(bundleWithCid, { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("fail");
    expect(result.consentAnchor).toBe("withdrawn");
    expect(result.overall).toBe("failed");
  });

  it("a withdrawn consent next to an unavailable document anchor stays withdrawn: an RPC outage never downgrades a verified receipt (R13)", async () => {
    const bundleWithCid = onReadableRegistry(artefact("cidv1.bundle"));
    const cidRoot = String(bundleWithCid["merkleRoot"]);
    const rpc = rpcFetch((m, params) => {
      if (m !== "eth_call") return null;
      const data = (params[0] as { data: string }).data;
      return data.startsWith("0x6d6f398e") ? new Response("down", { status: 503 }) : anchorWord(cidRoot, 1760000000, 1760000600, 2);
    });
    const result = await verify(bundleWithCid, { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.consentAnchor).toBe("withdrawn");
    expect(result.overall).toBe("withdrawn");
  });

  it("on Base mainnet the consent anchor is read at the mainnet registry by eth_call", async () => {
    const named = structuredClone(bundle()) as { didDocuments: { issuer: { delegation: { body: Record<string, unknown> } } } };
    named.didDocuments.issuer.delegation.body["registry"] = MAINNET_REGISTRY.toLowerCase();
    named.didDocuments.issuer.delegation.body["chainId"] = "8453";
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord(root(), 1760000000) : null));
    const result = await verify(named, { rpcUrl: "https://rpc.test", chainId: 8453, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("pass");
    expect(result.overall).toBe("verified");
    const call = rpc.calls.find((c) => c.method === "eth_call")!;
    expect((call.params[0] as { to: string }).to).toBe(MAINNET_REGISTRY);
  });

  it("a four-word answer is unreadable, never a record", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord(root(), 1760000000).slice(0, 2 + 256) : null));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("unavailable");
  });

  it("a record under another Merkle root FAILS", async () => {
    const rpc = rpcFetch((m) => (m === "eth_call" ? anchorWord("0x" + "99".repeat(32), 1760000000) : null));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("an RPC error or a record not anchored yet is unavailable, never failed", async () => {
    const down = rpcFetch(() => new Response("down", { status: 502 }));
    const pending = rpcFetch((m) => (m === "eth_call" ? anchorWord("0x" + "00".repeat(32), 0, 0, 0) : null));
    for (const rpc of [down, pending]) {
      const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
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
