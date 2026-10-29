import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import {
  DEFAULT_IPFS_GATEWAYS,
  MAX_SINGLE_BLOCK_BYTES,
  bytesMatchCid,
  cidIsComputable,
  gatewayName,
  gatewayUrl,
  readPinnedFile,
} from "../../src/verify/ipfs.js";
import type { DidDocument, VerifyReceiptOptions } from "../../src/verify/types.js";

// vectors/ipfs-gateways.json: a gateway is trusted for nothing. Its bytes count only once they re-encode to the CID;
// anything else moves to the next gateway, and only bytes that ARE the file can fail the copy.

const vectorPath = (rel: string) => fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url));
const read = <T>(rel: string): T => JSON.parse(readFileSync(vectorPath(rel), "utf8")) as T;

type Answer = { status: number; body?: "pinned" | "html" | "other-json" | "oversize" } | { network: "error" };

const IPFS = read<{
  defaultGateways: string[];
  cid: string;
  file: string;
  bundle: string;
  cases: Array<{
    name: string;
    options?: { ipfsGateways?: string[]; ipfsGateway?: string };
    answers: Record<string, Answer>;
    expect: { disclosureCopy: string; disclosureGateway?: string; tried: string[] };
  }>;
}>("ipfs-gateways.json");
const PINNED = new Uint8Array(readFileSync(vectorPath(IPFS.file)));
const DOCS = read<Record<string, DidDocument>>("receipts/did-documents.json");

const BODIES: Record<string, Uint8Array> = {
  pinned: PINNED,
  html: new TextEncoder().encode("<!doctype html><html><body>This domain is parked.</body></html>"),
  "other-json": new TextEncoder().encode(JSON.stringify({ disclosure: {} })),
  oversize: new TextEncoder().encode(" ".repeat(MAX_SINGLE_BLOCK_BYTES + 1)),
};

/** A network of gateways answering by URL; a URL with no answer is a network error. */
function gateways(answers: Record<string, Answer>): { fetch: typeof fetch; tried: string[] } {
  const tried: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    tried.push(url);
    const answer = answers[url];
    if (answer === undefined || "network" in answer) throw new TypeError("fetch failed");
    return new Response(answer.body === undefined ? "" : BODIES[answer.body]!, { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetch: impl, tried };
}

describe("ipfs-gateways.json", () => {
  it("the default list is the measured one, and the pinned file re-encodes to its CID", () => {
    expect([...DEFAULT_IPFS_GATEWAYS]).toEqual(IPFS.defaultGateways);
    expect(PINNED.length).toBe(4096);
    expect(bytesMatchCid(IPFS.cid, PINNED)).toBe(true);
  });

  it.each(IPFS.cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const net = gateways(c.answers);
    const options: VerifyReceiptOptions = {
      resolver: (did) => DOCS[did] ?? null,
      verifyDisclosure: true,
      fetch: net.fetch,
      ...(c.options?.ipfsGateways !== undefined ? { ipfsGateways: c.options.ipfsGateways } : {}),
      ...(c.options?.ipfsGateway !== undefined ? { ipfsGateway: c.options.ipfsGateway } : {}),
    };
    const result = await Agreely.verifyReceipt(read(IPFS.bundle), options);
    expect(result.disclosureCopy).toBe(c.expect.disclosureCopy);
    if (c.expect.disclosureGateway === undefined) expect(result).not.toHaveProperty("disclosureGateway");
    else expect(result.disclosureGateway).toBe(c.expect.disclosureGateway);
    expect(net.tried).toEqual(c.expect.tried);
    if (c.expect.disclosureCopy === "unavailable" && c.expect.tried.length > 0) {
      const note = result.notes.find((n) => n.startsWith("disclosureCopy UNAVAILABLE")) ?? "";
      for (const url of c.expect.tried) expect(note).toContain(new URL(url).host);
      expect(note).toContain("This is NOT a hash mismatch");
    }
  });
});

describe("the CID re-encoding a gateway's bytes must pass", () => {
  it("one byte off, a body that is not the file, or one over a block never matches a CIDv0", () => {
    const flipped = PINNED.slice();
    flipped[0] = flipped[0]! ^ 1;
    expect(bytesMatchCid(IPFS.cid, flipped)).toBe(false);
    expect(bytesMatchCid(IPFS.cid, BODIES["other-json"]!)).toBe(false);
    expect(bytesMatchCid(IPFS.cid, BODIES["oversize"]!)).toBe(false);
  });

  it("a base32 CIDv1 over sha2-256 is recomputed; anything else is not computable", () => {
    expect(cidIsComputable(IPFS.cid)).toBe(true);
    expect(cidIsComputable("bafkreiv2000000000000000000000000000000000000000000000000000001")).toBe(false);
    expect(cidIsComputable("zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA")).toBe(false);
    expect(bytesMatchCid("not-a-cid", PINNED)).toBeNull();
  });

  it("a prefix gets the CID appended, a template gets it substituted, a function is asked", () => {
    expect(gatewayUrl("https://g.example/ipfs/", "Qm1")).toBe("https://g.example/ipfs/Qm1");
    expect(gatewayUrl("https://g.example/ipfs", "Qm1")).toBe("https://g.example/ipfs/Qm1");
    expect(gatewayUrl("https://g.example/x/{cid}?a=1", "Qm1")).toBe("https://g.example/x/Qm1?a=1");
    expect(gatewayUrl((cid) => `https://f.example/${cid}`, "Qm1")).toBe("https://f.example/Qm1");
    expect(gatewayName((cid) => `https://f.example/${cid}`, "https://f.example/Qm1")).toBe("https://f.example");
  });
});

describe("readPinnedFile", () => {
  const judge = (bytes: Uint8Array) => (Buffer.from(bytes).equals(Buffer.from(PINNED)) ? "pass" : "fail");

  it("bytes that ARE the file decide, even against the signed hash, and no further gateway is asked", async () => {
    const net = gateways({
      ["https://a.example/ipfs/" + IPFS.cid]: { status: 200, body: "pinned" },
      ["https://b.example/ipfs/" + IPFS.cid]: { status: 200, body: "pinned" },
    });
    const out = await readPinnedFile(IPFS.cid, ["https://a.example/ipfs/", "https://b.example/ipfs/"], net.fetch, 1000, () => "fail", () => false);
    expect(out).toEqual({ delivered: true, gateway: "https://a.example/ipfs/", verdict: "fail" });
    expect(net.tried).toHaveLength(1);
  });

  it("never sends accept: application/json", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const impl = (async (_u: string | URL, init?: RequestInit) => {
      seen.push(init);
      return new Response(PINNED);
    }) as unknown as typeof fetch;
    await readPinnedFile(IPFS.cid, ["https://a.example/ipfs/"], impl, 1000, judge, (v) => v === "pass");
    expect(new Headers(seen[0]?.headers).get("accept")).toBeNull();
  });

  it("a gateway slower than the attempt bound is abandoned for the next", async () => {
    const tried: string[] = [];
    const impl = (async (u: string | URL, init?: RequestInit) => {
      tried.push(String(u));
      if (String(u).startsWith("https://slow.example")) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return new Response(PINNED);
    }) as unknown as typeof fetch;
    const out = await readPinnedFile(IPFS.cid, ["https://slow.example/ipfs/", "https://a.example/ipfs/"], impl, 50, judge, (v) => v === "pass");
    expect(out).toEqual({ delivered: true, gateway: "https://a.example/ipfs/", verdict: "pass" });
    expect(tried).toHaveLength(2);
  });
});
