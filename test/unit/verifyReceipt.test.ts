import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely, ReceiptVerifier } from "../../src/index.js";
import { canonicalize } from "../../src/crypto/jcs.js";
import type { DidDocument, VerifyReceiptOptions } from "../../src/verify/types.js";
import { keccak256Hex } from "../../src/crypto/keccak.js";
import { MAINNET_REGISTRY, SEPOLIA_REGISTRY, rootWord } from "./registry.js";

/** EIP-55 mixed-case checksum of a hex address. */
function eip55(address: string): string {
  const lower = address.replace(/^0x/i, "").toLowerCase();
  const hash = keccak256Hex(lower).replace(/^0x/, "");
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i]!;
    out += /[0-9]/.test(char) || parseInt(hash[i]!, 16) < 8 ? char : char.toUpperCase();
  }
  return out;
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/vectors.json", import.meta.url)), "utf8"),
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
    opts.verifyDisclosure = true;
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

/**
 * A JSON-RPC endpoint stub that answers every eth_call with `answer`. Every eth_call request body is recorded in
 * `sent`; any other POST is answered with an error.
 */
function chainFetch(answer: string): { fetch: typeof fetch; sent: string[] } {
  const sent: string[] = [];
  const impl = (async (_input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const req = JSON.parse(String(init.body)) as { method: string };
      if (req.method !== "eth_call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "no" } }));
      sent.push(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(fixtures.ipfsBody), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, sent };
}

const bundleVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/vectors.json", import.meta.url)), "utf8"),
) as {
  bundleVerification: {
    didDocuments: string;
    cases: Array<{ name: string; file: string; resolveDids: boolean | "none"; ipfsBody?: unknown; expect: unknown }>;
  };
};

function vectorFile(rel: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8"));
}

describe("Agreely.verifyReceipt on genuine and forged receipts and bundles (golden vectors, byte-identical across SDKs)", () => {
  const { cases: bundleCases, didDocuments } = bundleVectors.bundleVerification;
  const docs = vectorFile(didDocuments) as Record<string, DidDocument>;
  for (const c of bundleCases) {
    it(c.name, async () => {
      const opts: VerifyReceiptOptions = {
        resolver: c.resolveDids === "none" ? () => null : (did: string) => docs[did] ?? null,
      };
      if (c.ipfsBody !== undefined) {
        opts.verifyDisclosure = true;
        opts.ipfsGateway = (cid: string) => `https://ipfs.test/${cid}`;
        opts.fetch = (async () =>
          new Response(JSON.stringify(c.ipfsBody), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
      }
      const result = await Agreely.verifyReceipt(vectorFile(c.file), opts);
      expect(canonicalize(result as unknown)).toBe(canonicalize(c.expect));
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

  it("documentAnchor passes on a consent-document record read by eth_call rootOf(keccak256(cid)) (explicit Base Sepolia)", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const chain = chainFetch(rootWord(3));
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chain.fetch,
      rpcUrl: "https://rpc.test",
      chainId: 84532,
    });
    expect(result.documentAnchor).toBe("pass");
    expect(result.documentAnchorRecord).toEqual({ anchoredAt: 1790816400, anchoredBlock: 53000000 });
    const receipt = citizenCase.receipt as { credentialSubject: { consent: { document: { ipfsCid: string } } } };
    const cid = receipt.credentialSubject.consent.document.ipfsCid;
    const call = (JSON.parse(chain.sent[0]!) as { params: Array<{ to: string; data: string }> }).params[0]!;
    expect(call.to).toBe(SEPOLIA_REGISTRY);
    expect(call.data).toBe(keccak256Hex("rootOf(bytes32)").slice(0, 10) + keccak256Hex(cid).slice(2));
  });

  it("documentAnchor is UNAVAILABLE, not fail, while no record exists yet: a document is anchored after it is published", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chainFetch(rootWord(0)).fetch,
      rpcUrl: "https://rpc.test",
      chainId: 84532,
    });
    expect(result.documentAnchor).toBe("unavailable");
    expect(result.documentAnchorRecord).toBeUndefined();
    expect(result.overall).not.toBe("failed");
    expect(result.notes.join("\n")).toContain("not anchored yet");
  });

  it.each([
    [1, "as an audit-family root, not as a consent document"],
    [2, "as a cookie consent root, not as a consent document"],
    [7, "as a root of lane 7, not as a consent document"],
  ])("documentAnchor FAILS on a rootOf record in lane %i", async (lane, reason) => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chainFetch(rootWord(lane)).fetch,
      rpcUrl: "https://rpc.test",
      chainId: 84532,
    });
    expect(result.documentAnchor).toBe("fail");
    expect(result.documentAnchorRecord).toBeUndefined();
    expect(result.notes.join("\n")).toContain(reason);
  });

  it("documentAnchor FAILS on a tagged document record, which a consent document never is", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chainFetch(rootWord(3, 1790816400, 53000000, 9)).fetch,
      rpcUrl: "https://rpc.test",
      chainId: 84532,
    });
    expect(result.documentAnchor).toBe("fail");
    expect(result.notes.join("\n")).toContain("a tagged document");
  });

  it("on Base mainnet, the default chain, the anchor check reads the mainnet registry by eth_call", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const chain = chainFetch(rootWord(3));
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chain.fetch,
      rpcUrl: "https://rpc.test",
    });
    expect(result.documentAnchor).toBe("pass");
    expect(result.notes.join("\n")).not.toContain("no known registry");
    const call = (JSON.parse(chain.sent[0]!) as { params: Array<{ to: string }> }).params[0]!;
    expect(call.to).toBe(MAINNET_REGISTRY);
  });

  it("an explicit registryAddress is read by eth_call, on any chain", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const chain = chainFetch(rootWord(3));
    const explicit = "0x00000000000000000000000000000000000000aa";
    const result = await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chain.fetch,
      rpcUrl: "https://rpc.test",
      registryAddress: explicit,
    });
    expect(result.documentAnchor).toBe("pass");
    expect((JSON.parse(chain.sent[0]!) as { params: Array<{ to: string }> }).params[0]!.to).toBe(explicit);
  });

  // The address the verifier ACTUALLY PUTS ON THE WIRE must be EIP-55
  // checksummed. Read back out of the composed eth_call payload, not from the test's
  // own copy of the constant, so this cannot pass tautologically. A mis-cased address
  // still works over JSON-RPC (addresses compare case-insensitively on chain), so bad
  // casing is invisible at runtime and only surfaces where a human or a
  // checksum-validating tool reads it.
  // THE DEFAULT DID HOSTS, read back off the URLs the verifier actually FETCHES.
  //
  // Both defaults were wrong in v0.2.0 and both were silent:
  //
  //   - the company did:web host defaulted to the apex `agreely.ca`, which is the
  //     MARKETING SITE and 404s on /c/{slug}/did.json. The document is served by the
  //     Agreely WEB tier (app.agreely.ca); the route is MODE=WEB only.
  //   - the citizen resolver base defaulted to `api.agreely.ca`, which does not route
  //     GET /did/{did} at all (that is MODE=CITIZEN, my.agreely.ca). Every citizen
  //     receipt verified with the default resolver therefore reported citizenAssertion
  //     "unavailable" and overall "unavailable": never a false "verified", but never a
  //     real verification either.
  //
  // These assert the composed URL, not a second copy of the constant, so they cannot
  // pass tautologically. If one fails, confirm the tier that actually serves the route
  // before touching it: probe `https://<host>/c/<slug>/did.json` (expect 200) and
  // `https://<host>/did/notadid` (expect 400 "invalid did", which proves the route
  // exists) rather than assuming.
  it("resolves a company did:web against the WEB tier by default", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      fetched.push(String(input));
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    await new ReceiptVerifier({ fetch: fetchImpl }).resolveCompanyDid("acme");

    expect(fetched).toEqual(["https://app.agreely.ca/c/acme/did.json"]);
  });

  it("resolves a citizen DID against the CITIZEN tier by default", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const citizenDid = "did:agreely:citizen:BXZMTST2EGHYNQ62Q8AJWH8Q08";
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      fetched.push(String(input));
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    await Agreely.verifyReceipt(citizenCase.receipt, {
      verifyDisclosure: false,
      fetch: fetchImpl,
    });

    expect(fetched).toContain(`https://my.agreely.ca/did/${encodeURIComponent(citizenDid)}`);
    for (const url of fetched) {
      expect(url).not.toContain("api.agreely.ca");
    }
  });

  it("sends an EIP-55 checksummed registry address", async () => {
    const citizenCase = cases.find((c) => c.ipfs)!;
    const chain = chainFetch(rootWord(0));
    await Agreely.verifyReceipt(citizenCase.receipt, {
      resolver: (did) => fixtures.didDocuments[did] ?? null,
      fetch: chain.fetch,
      rpcUrl: "https://rpc.test",
      chainId: 84532,
    });
    const sent = (JSON.parse(chain.sent[0]!) as { params: Array<{ to: string }> }).params[0]?.to;

    expect(sent).toBeDefined();
    expect(sent).toBe(eip55(sent!));
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

  it("a citizen receipt NEVER reports cellLabelBinding: pass, a mutated label is honestly 'unsupported' offline, never presented as verified", async () => {
    const genuine = await Agreely.verifyReceipt(structuredClone(citizenCase().receipt), {
      resolver,
      ipfsGateway: (cid) => `https://ipfs.test/${cid}`,
      fetch: (async () =>
        new Response(JSON.stringify(fixtures.ipfsBody), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(genuine.cellLabelBinding).toBe("unsupported");

    const receipt = structuredClone(citizenCase().receipt) as Record<string, unknown>;
    const items = (receipt.credentialSubject as { consent: { items: Array<Record<string, unknown>> } }).consent.items;
    items[0]!.category = "HACKED"; // offline, no salt/commitment/root to cross-check against, see the note
    const mutated = await Agreely.verifyReceipt(receipt, {
      resolver,
      verifyDisclosure: false,
    });
    // Offline the citizen label cannot be cryptographically failed (by design), but it is
    // never 'pass', and the result is at most 'partial', a relying party is not misled.
    expect(mutated.cellLabelBinding).toBe("unsupported");
    expect(mutated.cellLabelBinding).not.toBe("pass");
    expect(mutated.overall).not.toBe("verified");
    expect(mutated.notes.some((n) => n.includes("Do NOT trust the displayed labels"))).toBe(true);
  });
});

describe("default did:web resolution targets the company DID host that actually serves it", () => {
  // A company DID is did:web:app.agreely.ca:c:{slug}, served at
  // https://app.agreely.ca/c/{slug}/did.json by the Agreely WEB (dashboard) tier.
  //
  // This block previously pinned the APEX `agreely.ca`, which is the marketing site and
  // 404s on that path: the assertions encoded the bug rather than catching it (one of
  // them compared a string literal against itself). The composed URL is asserted in
  // "resolves a company did:web against the WEB tier by default" above; what is left
  // here is the DID STRING the helper builds, which is what ends up inside a receipt.
  it("resolveCompanyDid(slug) builds did:web:app.agreely.ca:c:{slug}", async () => {
    let seenDid: string | undefined;
    const verifier = new ReceiptVerifier({
      resolver: (did) => {
        seenDid = did;
        return null;
      },
    });
    await verifier.resolveCompanyDid("acme");
    expect(seenDid).toBe("did:web:app.agreely.ca:c:acme");
    // Neither the apex (marketing, 404s) nor the api tier (does not serve did.json).
    expect(seenDid).not.toBe("did:web:agreely.ca:c:acme");
    expect(seenDid).not.toContain("api.agreely.ca");
  });

  // companyDidHost still overrides the default, which is how a self-hosted or
  // white-labelled deployment points the resolver at its own domain.
  it("companyDidHost overrides the default", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      fetched.push(String(input));
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    await new ReceiptVerifier({
      companyDidHost: "consent.example.test",
      fetch: fetchImpl,
    }).resolveCompanyDid("acme");

    expect(fetched).toEqual(["https://consent.example.test/c/acme/did.json"]);
  });
});

describe("a VERBAL receipt (VerbalConsentReceipt, company_documented) is never read as paper nor as citizen", () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes: Uint8Array): string {
    let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
    let out = "";
    while (n > 0n) {
      out = B58[Number(n % 58n)]! + out;
      n /= 58n;
    }
    for (const b of bytes) {
      if (b !== 0) break;
      out = "1" + out;
    }
    return out;
  }

  const issuer = "did:web:app.agreely.ca:c:acme";
  const vm = `${issuer}#kms-1`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const didDoc = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: issuer,
    verificationMethod: [
      { id: vm, type: "Multikey", controller: issuer, publicKeyMultibase: "z" + base58(new Uint8Array([0xed, 0x01, ...rawPub])) },
    ],
  } as unknown as DidDocument;
  const resolver = (did: string): DidDocument | null => (did === issuer ? didDoc : null);

  function signedVerbalReceipt(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      "@context": ["https://www.w3.org/ns/credentials/v2", "https://agreely.ca/credentials/consent/v1"],
      type: ["VerifiableCredential", "ConsentReceipt", "VerbalConsentReceipt"],
      id: "urn:agreely:receipt:verbal-1",
      issuer,
      assuranceLevel: "company_documented",
      validFrom: "2026-09-29T14:05:00Z",
      validUntil: "2027-09-30T03:59:59Z",
      credentialSubject: {
        consent: {
          action: "grant",
          channel: "telephone",
          items: [{ itemId: "0x01", category: "Coordonnees", purpose: "Infolettre" }],
          documentVersion: "11111111-2222-3333-4444-555555555555",
          document: { code: "conditions", name: "Conditions", version: "3", effectiveDate: "2026-09-01" },
          grantedAt: "2026-09-29T14:05:00Z",
          declinedItems: [{ itemId: "0x02", category: "Coordonnees", purpose: "Sondages" }],
        },
      },
      evidence: {
        type: "VerbalConsentDocumentedByOrganisation",
        scriptVersion: "script-2026.09",
        documentVersion: "11111111-2222-3333-4444-555555555555",
      },
    };
    const sig = cryptoSign(null, Buffer.from(canonicalize(body), "utf8"), privateKey);
    return {
      ...body,
      proof: [
        {
          type: "DataIntegrityProof",
          cryptosuite: "eddsa-jcs-2022",
          created: "2026-09-29T14:07:12Z",
          verificationMethod: vm,
          proofPurpose: "assertionMethod",
          proofValue: "z" + base58(new Uint8Array(sig)),
        },
      ],
    };
  }

  it("a genuine verbal receipt: company signature passes, receiptType company_documented, overall PARTIAL (never verified)", async () => {
    const result = await Agreely.verifyReceipt(signedVerbalReceipt(), { resolver });
    expect(result.receiptType).toBe("company_documented");
    expect(result.companySignature).toBe("pass");
    expect(result.citizenAssertion).toBe("unsupported");
    expect(result.cellLabelBinding).toBe("pass");
    expect(result.overall).toBe("partial");
    expect(result.notes.join(" ")).toMatch(/does NOT prove the call happened/);
  });

  it("a tampered verbal receipt fails", async () => {
    const receipt = signedVerbalReceipt();
    (receipt.evidence as Record<string, unknown>).scriptVersion = "another-script";
    const result = await Agreely.verifyReceipt(receipt, { resolver });
    expect(result.receiptType).toBe("company_documented");
    expect(result.companySignature).toBe("fail");
    expect(result.overall).toBe("failed");
  });

  it("an unresolvable issuer is unavailable, not a forgery", async () => {
    const result = await Agreely.verifyReceipt(signedVerbalReceipt(), { resolver: () => null });
    expect(result.companySignature).toBe("unavailable");
    expect(result.overall).toBe("unavailable");
  });

  it("a receipt body holding a number the canonicalizer refuses is malformed, and does not throw", async () => {
    const receipt = signedVerbalReceipt();
    (receipt.evidence as Record<string, unknown>).attempts = 2;
    const result = await Agreely.verifyReceipt(receipt, { resolver });
    expect(result.overall).toBe("malformed");
    expect(result.receiptType).toBe("company_documented");
    expect(result.notes.join(" ")).toContain("the receipt body cannot be canonicalized");
  });
});
