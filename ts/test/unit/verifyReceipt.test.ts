import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { canonicalize } from "../../src/crypto/jcs.js";
import type { DidDocument, VerifyReceiptOptions } from "../../src/verify/types.js";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../vectors/vectors.json", import.meta.url)), "utf8"),
) as {
  receiptVerification: {
    fixtures: { didDocuments: Record<string, DidDocument>; ipfsBody: unknown };
    cases: Array<{
      name: string;
      resolveDids: boolean | "none";
      ipfs: boolean;
      receipt: unknown;
      expect: unknown;
    }>;
  };
};

const { fixtures, cases } = vectors.receiptVerification;

function optionsFor(c: (typeof cases)[number]): VerifyReceiptOptions {
  const opts: VerifyReceiptOptions = {};
  if (c.resolveDids === "none") {
    // Simulate an unresolvable DID (network/outage): the resolver always returns
    // null, so the decisive check is "unavailable" (inconclusive), not "fail".
    opts.resolver = () => null;
  } else if (c.resolveDids) {
    opts.resolver = (did: string) => fixtures.didDocuments[did] ?? null;
  }
  if (c.ipfs) {
    opts.ipfsGateway = (cid: string) => `https://ipfs.test/${cid}`;
    opts.fetch = (async () =>
      new Response(JSON.stringify(fixtures.ipfsBody), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  }
  return opts;
}

describe("Agreely.verifyReceipt (offline golden vectors, byte-identical across SDKs)", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const result = await Agreely.verifyReceipt(c.receipt, optionsFor(c));
      // Byte-identical assertion via the shared JCS canonicalizer (the same
      // discipline the PHP suite uses, so TS and PHP can never drift).
      expect(canonicalize(result as unknown)).toBe(canonicalize(c.expect));
      expect(result).toEqual(c.expect);
    });
  }
});

describe("verifyReceipt honesty matrix edge cases", () => {
  it("citizen assertion FAILS when the signed challenge does not match the receipt challenge", async () => {
    const citizen = structuredClone(cases.find((c) => c.receipt && (c.receipt as { credentialSubject?: { id?: string } }).credentialSubject?.id)!.receipt) as Record<
      string,
      unknown
    >;
    const proof = (citizen["proof"] as Array<Record<string, unknown>>)[1]!;
    proof["challenge"] = "0x" + "00".repeat(32); // tamper the committed challenge
    const result = await Agreely.verifyReceipt(citizen, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      // Stub the IPFS fetch so the offline test never touches the network.
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(result.citizenAssertion).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("company signature is UNAVAILABLE (not fail) when the issuer DID cannot be resolved", async () => {
    const manual = cases[0]!.receipt;
    const result = await Agreely.verifyReceipt(manual, { resolver: () => null });
    // A DID-resolution outage is INCONCLUSIVE, never byte-identical to a forgery.
    expect(result.companySignature).toBe("unavailable");
    expect(result.overall).toBe("unavailable");
  });

  it("a throwing resolver is treated as unavailable, not a hard failure", async () => {
    const manual = cases[0]!.receipt;
    const result = await Agreely.verifyReceipt(manual, {
      resolver: () => {
        throw new Error("network down");
      },
    });
    expect(result.companySignature).toBe("unavailable");
    expect(result.overall).toBe("unavailable");
  });

  it("disclosureCopy is skipped for a manual receipt (no ipfsCid + disclosureHash)", async () => {
    const result = await Agreely.verifyReceipt(cases[0]!.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
    });
    expect(result.disclosureCopy).toBe("skipped");
  });

  it("documentAnchor passes when a matching on-chain log is returned (opt-in rpcUrl)", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        // eth_getLogs — return one matching log.
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ blockNumber: "0x1" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(fixtures.ipfsBody), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      ipfsGateway: (cid) => `https://ipfs.test/${cid}`,
      fetch: fetchImpl,
      rpcUrl: "https://rpc.test",
    });
    expect(result.documentAnchor).toBe("pass");
  });
});
