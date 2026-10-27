import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { canonicalize } from "../../src/crypto/jcs.js";
import { testIssuer } from "./signing.js";

// A v2 consent: at least one cell rests on a non-consent basis, so the app seals the disclosureHash over
// {disclosure, legalBasis} and stamps disclosureVersion "2" (ConsentRequestService, the v2 branch). On a
// passkey consent only the OFFER is company-signed: the copy is checked against the offer's hash and basis.

const DISCLOSURE = {
  purpose: { fr: "Fins de prestation du service demandé.", en: "Purposes of the requested service." },
  responsable: { name: "Acme Responsable de la protection", contact: "privacy@acme.example" },
};

const LEGAL_BASIS = {
  "0x01": {
    basis: "necessary_for_service",
    justificationFr: "Nécessaire à la prestation du service demandé.",
    justificationEn: "Necessary to provide the requested service.",
  },
};

// Computed by the APP's own canonicalizer, App\Models\Crypto\Canonicalizer (the class ConsentRequestService seals
// with), not by this SDK:
//   docker compose exec -T web php -r 'require "vendor/autoload.php"; $c = new App\Models\Crypto\Canonicalizer();
//     $disclosure = [...]; $legalBasis = [...]; $preimage = $c->encode(["disclosure" => $disclosure,
//     "legalBasis" => $legalBasis]); echo "0x" . hash("sha256", $preimage);'
// The TS formula must reproduce this byte for byte, which is what proves cross-language parity.
const PHP_V2_DISCLOSURE_HASH = "0xa589592c89690e3cb2cb8ee4bcf2599fb0ba776372db0203d5463860ffa968bc";

const CID = "bafkreiv2000000000000000000000000000000000000000000000000000001";

// The pinned IPFS body, as IpfsDocumentService::canonicalPayload writes it: the disclosure map, and no legalBasis.
const IPFS_BODY = {
  code: "marketing",
  name: "Marketing",
  version: "1.0",
  effectiveDate: "2026-01-01",
  disclosure: DISCLOSURE,
};

const DOCUMENT = { code: "marketing", name: "Marketing", version: "1.0", effectiveDate: "2026-01-01", ipfsCid: CID };
const ITEMS = [{ itemId: "0x01", category: "email address", purpose: "marketing outreach" }];
const GRANTED_AT = "2026-01-15T12:00:00Z";

const company = testIssuer();

function sha256Of(preimage: unknown): string {
  return "0x" + createHash("sha256").update(canonicalize(preimage)).digest("hex");
}

/** A company-signed v2 offer (edit it before signing for a v1 or another variant). */
function offer(edit: (o: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const o: Record<string, unknown> = {
    issuer: company.issuer,
    requestId: "0x" + "cd".repeat(32),
    nonce: "0x" + "ef".repeat(32),
    validUntil: "",
    consent: { action: "grant", items: structuredClone(ITEMS) },
    document: structuredClone(DOCUMENT),
    disclosure: structuredClone(DISCLOSURE),
    disclosureHash: PHP_V2_DISCLOSURE_HASH,
    disclosureVersion: "2",
    legalBasis: structuredClone(LEGAL_BASIS),
  };
  edit(o);
  return o;
}

/**
 * The passkey receipt the app derives from `o`, signed (proof[0]) over the offer. proof[1] has the issued shape but
 * signs nothing: only the company half matters here.
 */
function bundleOf(o: Record<string, unknown>, editConsent: (c: Record<string, unknown>) => void = () => {}) {
  const consent: Record<string, unknown> = {
    action: "grant",
    items: structuredClone(ITEMS),
    requestId: o["requestId"],
    grantedAt: GRANTED_AT,
    document: structuredClone(o["document"]),
    disclosureHash: o["disclosureHash"],
  };
  if (o["legalBasis"] !== undefined) {
    consent["disclosureVersion"] = o["disclosureVersion"];
    consent["legalBasis"] = structuredClone(o["legalBasis"]);
  }
  editConsent(consent);
  return {
    version: "1",
    receipt: {
      "@context": ["https://www.w3.org/ns/credentials/v2", "https://agreely.ca/credentials/consent/v1"],
      type: ["VerifiableCredential", "ConsentReceipt"],
      id: "urn:agreely:receipt:00000000-0000-4000-8000-000000000002",
      issuer: company.issuer,
      validFrom: GRANTED_AT,
      validUntil: "",
      credentialSubject: { id: "did:agreely:citizen:v2", consent },
      proof: [
        company.proofOver(o),
        {
          type: "WebAuthnAssertion",
          verificationMethod: "did:agreely:citizen:v2#passkey-1",
          nonce: o["nonce"],
          challenge: "0x" + "00".repeat(32),
          authenticatorData: "",
          clientDataJSON: "",
          signature: "",
        },
      ],
    },
    signedOffer: o,
    merkleRoot: "0x" + "ab".repeat(32),
  };
}

function gateway(body: unknown, status = 200) {
  const fetched: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, fetched };
}

/** Runs the verifier with the disclosure check requested and the IPFS body stubbed. */
async function verifyWithCopy(input: unknown, body: unknown = IPFS_BODY) {
  return Agreely.verifyReceipt(input, {
    resolver: company.resolver,
    verifyDisclosure: true,
    ipfsGateway: (cid: string) => `https://ipfs.test/${cid}`,
    fetch: gateway(body).fetchImpl,
  });
}

describe("disclosureCopy of a passkey bundle is checked against the SIGNED offer", () => {
  it("the TS formula reproduces the app's PHP v2 hash, and the v1 formula does not", () => {
    expect(sha256Of({ disclosure: DISCLOSURE, legalBasis: LEGAL_BASIS })).toBe(PHP_V2_DISCLOSURE_HASH);
    expect(sha256Of(DISCLOSURE)).not.toBe(PHP_V2_DISCLOSURE_HASH);
  });

  it("a v2 bundle with an authentic body passes, and the note names the version", async () => {
    const result = await verifyWithCopy(bundleOf(offer()));
    expect(result.companySignature).toBe("pass");
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.disclosureCopy).toBe("pass");
    expect(result.notes.join("\n")).toContain("disclosureVersion 2");
  });

  it("a v2 bundle whose IPFS disclosure was tampered FAILS", async () => {
    const tampered = structuredClone(IPFS_BODY);
    tampered.disclosure.purpose.en = "Marketing, shared with partners.";
    const result = await verifyWithCopy(bundleOf(offer()), tampered);
    expect(result.disclosureCopy).toBe("fail");
  });

  it("an IPFS body carrying a legalBasis that differs from the signed one FAILS", async () => {
    const body = { ...IPFS_BODY, legalBasis: { "0x01": { basis: "consent", justificationFr: "" } } };
    const result = await verifyWithCopy(bundleOf(offer()), body);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("differs from the signed one");
  });

  it("an IPFS body carrying the signed legalBasis still passes", async () => {
    const result = await verifyWithCopy(bundleOf(offer()), { ...IPFS_BODY, legalBasis: structuredClone(LEGAL_BASIS) });
    expect(result.disclosureCopy).toBe("pass");
  });

  it("a v1 offer (no legalBasis) passes on the disclosure alone", async () => {
    const v1 = offer((o) => {
      delete o["legalBasis"];
      o["disclosureVersion"] = "1";
      o["disclosureHash"] = sha256Of(DISCLOSURE);
    });
    const result = await verifyWithCopy(bundleOf(v1));
    expect(result.receiptIntegrity).toBe("pass");
    expect(result.disclosureCopy).toBe("pass");
  });

  it("a receipt whose legalBasis was rewritten with a recomputed hash fails its integrity, the copy being judged on the offer", async () => {
    const forgedBasis = { "0x01": { basis: "contract", justificationFr: "Contrat.", justificationEn: "Contract." } };
    const forged = bundleOf(offer(), (c) => {
      c["legalBasis"] = forgedBasis;
      c["disclosureHash"] = sha256Of({ disclosure: DISCLOSURE, legalBasis: forgedBasis });
    });
    const result = await verifyWithCopy(forged);
    expect(result.receiptIntegrity).toBe("fail");
    expect(result.overall).toBe("failed");
    expect(result.notes.join("\n")).toContain(`matches the signed disclosureHash ${PHP_V2_DISCLOSURE_HASH}`);
  });

  it("an offer whose signature cannot be checked is not compared: there is no signed hash", async () => {
    const result = await Agreely.verifyReceipt(bundleOf(offer()), {
      resolver: () => null,
      verifyDisclosure: true,
      fetch: gateway(IPFS_BODY).fetchImpl,
    });
    expect(result.disclosureCopy).toBe("skipped");
    expect(result.notes.join("\n")).toContain("no signed disclosureHash");
  });

  it("an IPFS body whose disclosure holds a number FAILS, and does not throw", async () => {
    const result = await verifyWithCopy(bundleOf(offer()), { ...IPFS_BODY, disclosure: { ...DISCLOSURE, copies: 3 } });
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("cannot be canonicalized");
  });
});

describe("the disclosure check is opt-in and a gateway error is never a hash mismatch", () => {
  it("is not run, and the gateway never called, unless verifyDisclosure is true", async () => {
    const gw = gateway(IPFS_BODY);
    const result = await Agreely.verifyReceipt(bundleOf(offer()), { resolver: company.resolver, fetch: gw.fetchImpl });
    expect(result.disclosureCopy).toBe("skipped");
    expect(gw.fetched).toEqual([]);
    expect(result.notes.join("\n")).toContain("verifyDisclosure: true");
  });

  it("a gateway answering 404 with a JSON body is unavailable, not a mismatch", async () => {
    const result = await Agreely.verifyReceipt(bundleOf(offer()), {
      resolver: company.resolver,
      verifyDisclosure: true,
      fetch: gateway({ error: "not found" }, 404).fetchImpl,
    });
    expect(result.disclosureCopy).toBe("unavailable");
    expect(result.notes.join("\n")).toContain("HTTP 404");
  });

  it("an unreachable gateway is unavailable", async () => {
    const result = await Agreely.verifyReceipt(bundleOf(offer()), {
      resolver: company.resolver,
      verifyDisclosure: true,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(result.disclosureCopy).toBe("unavailable");
  });
});

describe("a BARE passkey receipt never passes its disclosure copy (its hash and legalBasis are signed by nobody)", () => {
  it("a bare v2 receipt with a rewritten legalBasis and a recomputed hash is unsupported, and the gateway is never called", async () => {
    const forgedBasis = { "0x01": { basis: "contract", justificationFr: "Contrat.", justificationEn: "Contract." } };
    const { receipt } = bundleOf(offer(), (c) => {
      c["legalBasis"] = forgedBasis;
      c["disclosureHash"] = sha256Of({ disclosure: DISCLOSURE, legalBasis: forgedBasis });
    });
    const gw = gateway(IPFS_BODY);
    const result = await Agreely.verifyReceipt(receipt, {
      resolver: company.resolver,
      verifyDisclosure: true,
      fetch: gw.fetchImpl,
    });
    expect(result.disclosureCopy).toBe("unsupported");
    expect(result.overall).not.toBe("verified");
    expect(gw.fetched).toEqual([]);
  });
});

describe("a RECORDED receipt's disclosure copy reads the version and basis under the company signature", () => {
  /** A company-attested receipt carrying a CID and a disclosureHash, signed over its body. */
  function recorded(edit: (consent: Record<string, unknown>) => void): Record<string, unknown> {
    const consent: Record<string, unknown> = {
      action: "grant",
      items: structuredClone(ITEMS),
      document: structuredClone(DOCUMENT),
      grantedAt: GRANTED_AT,
      disclosureHash: PHP_V2_DISCLOSURE_HASH,
      disclosureVersion: "2",
      legalBasis: structuredClone(LEGAL_BASIS),
    };
    edit(consent);
    const body = {
      type: ["VerifiableCredential", "ConsentReceipt", "CompanyAttestedConsentReceipt"],
      issuer: company.issuer,
      assuranceLevel: "company_attested",
      validFrom: GRANTED_AT,
      credentialSubject: { consent },
      evidence: { type: "HandSignedPaperConsent", pdfHash: "0x" + "11".repeat(32) },
    };
    return { ...body, proof: [company.proofOver(body)] };
  }

  it("an authentic v2 recorded receipt passes", async () => {
    const result = await verifyWithCopy(recorded(() => {}));
    expect(result.companySignature).toBe("pass");
    expect(result.disclosureCopy).toBe("pass");
  });

  it("a v2 recorded receipt with NO legalBasis FAILS, and never falls back to the v1 formula", async () => {
    const result = await verifyWithCopy(
      recorded((c) => {
        delete c["legalBasis"];
        c["disclosureHash"] = sha256Of(DISCLOSURE);
      }),
    );
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("carries no legalBasis");
  });

  it("a legalBasis without disclosureVersion 2 FAILS, the preimage being ambiguous", async () => {
    const result = await verifyWithCopy(recorded((c) => (c["disclosureVersion"] = "1")));
    expect(result.disclosureCopy).toBe("fail");
  });

  it("an unknown disclosureVersion FAILS", async () => {
    const result = await verifyWithCopy(recorded((c) => (c["disclosureVersion"] = "3")));
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("unknown disclosureVersion");
  });

  it("an explicit disclosureVersion 1 with no legalBasis passes on the disclosure alone", async () => {
    const result = await verifyWithCopy(
      recorded((c) => {
        delete c["legalBasis"];
        c["disclosureVersion"] = "1";
        c["disclosureHash"] = sha256Of(DISCLOSURE);
      }),
    );
    expect(result.disclosureCopy).toBe("pass");
  });
});
