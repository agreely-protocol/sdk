import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { decodeAnchorRecord, decodeRootRecord } from "../../src/verify/receipt.js";
import type { DidDocument } from "../../src/verify/types.js";
import { SEPOLIA_REGISTRY, rootWord } from "./registry.js";

// test/fixtures/registry-reads.json is agreely-contracts vectors/registry-reads.json at bf122fb: the exact eth_call
// answers of AgreelyRegistry, asserted on the contract side by test/RegistryReadVectors.t.sol.
const VECTORS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/registry-reads.json", import.meta.url)), "utf8"),
) as Record<string, { selector: string; cases: Array<{ name: string; calldata: string; returnData: string; decoded: Record<string, unknown> }> }>;

describe("the frozen registry read vectors decode exactly", () => {
  it.each(VECTORS["registry"]!.cases.map((c) => [c.name, c] as const))("registry(bytes32) %s", (_name, c) => {
    expect(c.calldata.slice(0, 10)).toBe(VECTORS["registry"]!.selector);
    expect(decodeAnchorRecord(c.returnData)).toEqual(c.decoded);
  });

  it.each(VECTORS["rootOf"]!.cases.map((c) => [c.name, c] as const))("rootOf(bytes32) %s", (_name, c) => {
    expect(c.calldata.slice(0, 10)).toBe(VECTORS["rootOf"]!.selector);
    expect(decodeRootRecord(c.returnData)).toEqual(c.decoded);
  });

  it("a registry answer is read as a prefix of five words, never fewer", () => {
    const active = VECTORS["registry"]!.cases.find((c) => c.name === "active")!;
    expect(decodeAnchorRecord(active.returnData + "00".repeat(32))).toEqual(active.decoded);
    expect(decodeAnchorRecord(active.returnData.slice(0, 2 + 256))).toBeNull();
  });

  it("a rootOf record that contradicts itself is unreadable", () => {
    expect(decodeRootRecord(rootWord(3, 0, 0))).toBeNull();
    expect(decodeRootRecord("0x" + "00".repeat(32) + (1).toString(16).padStart(64, "0") + "00".repeat(64))).toBeNull();
  });
});

const RECEIPT = (JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/vectors.json", import.meta.url)), "utf8"),
) as { receiptVerification: { cases: Array<{ ipfs?: boolean; receipt: unknown }>; fixtures: { didDocuments: Record<string, DidDocument> } } })
  .receiptVerification;

describe("the registry the SDK reads, per chain", () => {
  const EMIT_ONLY = ["0x3532a9dff3c910152543afca49de7c66113c5312", "0x23577faffa306375028d33a559d0f95ced9424db"];

  async function sentTo(chainId: number | undefined): Promise<string[]> {
    const sent: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      sent.push(body.toLowerCase());
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rootWord(3) }));
    }) as unknown as typeof fetch;
    const receipt = RECEIPT.cases.find((c) => c.ipfs)!.receipt;
    await Agreely.verifyReceipt(receipt, {
      resolver: (did) => RECEIPT.fixtures.didDocuments[did] ?? null,
      rpcUrl: "https://rpc.test",
      fetch: fetchImpl,
      ...(chainId === undefined ? {} : { chainId }),
    });
    return sent;
  }

  it("Base Sepolia is read at the registry it serves by eth_call", async () => {
    const sent = await sentTo(84532);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`"to":"${SEPOLIA_REGISTRY.toLowerCase()}"`);
  });

  it.each([undefined, 8453, 84532])("chainId %s never reads an emit-only registry", async (chainId) => {
    const sent = await sentTo(chainId);
    expect(sent).toHaveLength(chainId === 84532 ? 1 : 0);
    for (const body of sent) {
      for (const address of EMIT_ONLY) expect(body).not.toContain(address);
      expect(body).not.toContain("eth_getlogs");
    }
  });
});
