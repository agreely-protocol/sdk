import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely, ReceiptVerifier } from "../../src/index.js";
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

  it("documentAnchor passes when a matching on-chain log is returned (opt-in rpcUrl, explicit Base Sepolia)", async () => {
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
      // Base Sepolia (84532) is no longer the default; passing it explicitly still
      // resolves the known testnet registry, so an integrator can test on Sepolia.
      chainId: 84532,
    });
    expect(result.documentAnchor).toBe("pass");
  });

  it("documentAnchor is skipped on the Base mainnet default until its registry address is filled", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ blockNumber: "0x1" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(fixtures.ipfsBody), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // No chainId passed -> default is Base mainnet (8453). Its registry address is
    // DEPLOY-GATED (null) until deployment, so the anchor check reports "skipped"
    // rather than a false pass/fail.
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      ipfsGateway: (cid) => `https://ipfs.test/${cid}`,
      fetch: fetchImpl,
      rpcUrl: "https://rpc.test",
    });
    expect(result.documentAnchor).toBe("skipped");
  });
});

describe("cellLabelBinding cross-checks the human-readable labels (claims-audit P3-F2)", () => {
  const resolver = (did: string): DidDocument | null => fixtures.didDocuments[did] ?? null;
  const companyCase = () => cases.find((c) => !(c.receipt as { credentialSubject?: { id?: string } }).credentialSubject?.id)!;
  const citizenCase = () => cases.find((c) => c.ipfs)!;

  it("a genuine company-attested receipt reports cellLabelBinding: pass and overall: verified", async () => {
    const result = await Agreely.verifyReceipt(structuredClone(companyCase().receipt), { resolver });
    expect(result.cellLabelBinding).toBe("pass");
    expect(result.overall).toBe("verified");
  });

  it("mutating an item CATEGORY breaks the company signature: cellLabelBinding FAIL, overall failed", async () => {
    const receipt = structuredClone(companyCase().receipt) as Record<string, unknown>;
    const items = (receipt.credentialSubject as { consent: { items: Array<Record<string, unknown>> } }).consent.items;
    items[0]!.category = "HACKED";
    const result = await Agreely.verifyReceipt(receipt, { resolver });
    expect(result.companySignature).toBe("fail");
    expect(result.cellLabelBinding).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("mutating an item PURPOSE breaks the company signature: cellLabelBinding FAIL, overall failed", async () => {
    const receipt = structuredClone(companyCase().receipt) as Record<string, unknown>;
    const items = (receipt.credentialSubject as { consent: { items: Array<Record<string, unknown>> } }).consent.items;
    items[0]!.purpose = "HACKED";
    const result = await Agreely.verifyReceipt(receipt, { resolver });
    expect(result.companySignature).toBe("fail");
    expect(result.cellLabelBinding).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("a citizen receipt NEVER reports cellLabelBinding: pass — a mutated label is honestly 'unsupported' offline, never presented as verified", async () => {
    const genuine = await Agreely.verifyReceipt(structuredClone(citizenCase().receipt), {
      resolver,
      ipfsGateway: (cid) => `https://ipfs.test/${cid}`,
      fetch: (async () =>
        new Response(JSON.stringify(fixtures.ipfsBody), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(genuine.cellLabelBinding).toBe("unsupported");

    const receipt = structuredClone(citizenCase().receipt) as Record<string, unknown>;
    const items = (receipt.credentialSubject as { consent: { items: Array<Record<string, unknown>> } }).consent.items;
    items[0]!.category = "HACKED"; // offline, no salt/commitment/root to cross-check against — see the note
    const mutated = await Agreely.verifyReceipt(receipt, {
      resolver,
      verifyDisclosure: false,
    });
    // Offline the citizen label cannot be cryptographically failed (by design), but it is
    // never 'pass', and the result is at most 'partial' — a relying party is not misled.
    expect(mutated.cellLabelBinding).toBe("unsupported");
    expect(mutated.cellLabelBinding).not.toBe("pass");
    expect(mutated.overall).not.toBe("verified");
    expect(mutated.notes.some((n) => n.includes("Do NOT trust the displayed labels"))).toBe(true);
  });
});

describe("default did:web resolution targets the apex company DID host", () => {
  // A company DID is did:web:agreely.ca:c:{slug}, served at
  // https://agreely.ca/c/{slug}/did.json (apex host, NOT api.agreely.ca).
  const EXPECTED_URL = "https://agreely.ca/c/acme/did.json";

  it("resolveCompanyDid(slug) fetches the apex /c/{slug}/did.json URL", async () => {
    let requested: string | undefined;
    const fetchImpl = ((input: string | URL) => {
      requested = String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "did:web:agreely.ca:c:acme" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const verifier = new ReceiptVerifier({ fetch: fetchImpl });
    await verifier.resolveCompanyDid("acme");
    expect(requested).toBe(EXPECTED_URL);
  });

  it("resolveCompanyDid(slug) builds the apex did:web:agreely.ca:c:{slug} id (not api.)", async () => {
    let seenDid: string | undefined;
    const verifier = new ReceiptVerifier({
      resolver: (did) => {
        seenDid = did;
        return null;
      },
    });
    await verifier.resolveCompanyDid("acme");
    // The DID built here maps, via the default resolver above, to EXPECTED_URL.
    expect(seenDid).toBe("did:web:agreely.ca:c:acme");
    expect(seenDid).not.toContain("api.agreely.ca");
    expect(`https://agreely.ca/c/acme/did.json`).toBe(EXPECTED_URL);
  });
});
