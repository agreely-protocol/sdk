import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import type { DidDocument } from "../../src/verify/types.js";
import { ANCHOR_BATCH_TOPIC, SEPOLIA_REGISTRY, vectorChainFetch, type VectorAnswers } from "./registry.js";
import { expectFields } from "./vectorCase.js";

// vectors/anchor-batch.json: how many refs one consent's anchor wrote, from the ONE AnchorBatch log of its trusted
// root at the ONE block its refs sit in. An unknown count never reads in force.

const read = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8")) as T;

const BATCH = read<{
  bundle: string;
  now: string;
  topic0: string;
  block: string;
  cases: Array<{ name: string; answers: VectorAnswers; expect: Record<string, unknown> & { getLogsCalls?: number } }>;
}>("anchor-batch.json");
const DOCS = read<Record<string, DidDocument>>("receipts/did-documents.json");

describe("anchor-batch.json", () => {
  it("the topic is keccak256 of the event signature", () => {
    expect(BATCH.topic0).toBe(ANCHOR_BATCH_TOPIC);
  });

  it.each(BATCH.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const rpc = vectorChainFetch(c.answers);
    const result = await Agreely.verifyReceipt(read(BATCH.bundle), {
      resolver: (did) => DOCS[did] ?? null,
      rpcUrl: "https://rpc.test",
      chainId: 84532,
      fetch: rpc.fetch,
      now: () => Number(BATCH.now) * 1000,
    });
    expectFields(result, c.expect);
    const getLogs = rpc.calls.filter((call) => call.method === "eth_getLogs");
    if (c.expect.getLogsCalls !== undefined) expect(getLogs).toHaveLength(c.expect.getLogsCalls);
    for (const call of getLogs) {
      const at = "0x" + BigInt(BATCH.block).toString(16);
      expect(call.params[0]).toMatchObject({ address: SEPOLIA_REGISTRY, fromBlock: at, toBlock: at, topics: [BATCH.topic0, expect.any(String)] });
    }
  });
});
