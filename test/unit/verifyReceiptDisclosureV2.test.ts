import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { canonicalize } from "../../src/crypto/jcs.js";

// A v2 receipt: at least one cell rests on a non-consent basis, so the app seals the disclosureHash over
// {disclosure, legalBasis} and stamps disclosureVersion "2" (ConsentRequestService, the v2 branch).

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

function sha256Of(preimage: unknown): string {
  return "0x" + createHash("sha256").update(canonicalize(preimage)).digest("hex");
}

function baseReceipt(): Record<string, unknown> {
  return {
    type: ["VerifiableCredential", "ConsentReceipt"],
    issuer: "did:web:api.agreely.ca:c:acme",
    credentialSubject: {
      id: "did:agreely:citizen:v2",
      consent: {
        action: "grant",
        items: [{ itemId: "0x01", category: "email address", purpose: "marketing outreach" }],
        requestId: "0x" + "cd".repeat(32),
        grantedAt: "2026-01-15T12:00:00Z",
        document: {
          code: "marketing",
          name: "Marketing",
          version: "1.0",
          effectiveDate: "2026-01-01",
          ipfsCid: CID,
        },
        disclosureHash: PHP_V2_DISCLOSURE_HASH,
        disclosureVersion: "2",
        legalBasis: structuredClone(LEGAL_BASIS),
      },
    },
    proof: [],
  };
}

/** A fresh receipt, with the consent block edited by `edit`. */
function receiptWith(edit: (consent: Record<string, unknown>) => void): Record<string, unknown> {
  const receipt = baseReceipt();
  edit((receipt["credentialSubject"] as { consent: Record<string, unknown> }).consent);
  return receipt;
}

/** Runs the verifier with the IPFS body stubbed. Only the disclosureCopy check is asserted on. */
async function disclosureCopyOf(receipt: Record<string, unknown>, body: unknown = IPFS_BODY) {
  return Agreely.verifyReceipt(receipt, {
    resolver: () => null,
    ipfsGateway: (cid: string) => `https://ipfs.test/${cid}`,
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  });
}

describe("disclosureCopy recomputes a v2 disclosureHash over {disclosure, legalBasis}", () => {
  it("the TS formula reproduces the app's PHP v2 hash, and the v1 formula does not", () => {
    expect(sha256Of({ disclosure: DISCLOSURE, legalBasis: LEGAL_BASIS })).toBe(PHP_V2_DISCLOSURE_HASH);
    expect(sha256Of(DISCLOSURE)).not.toBe(PHP_V2_DISCLOSURE_HASH);
  });

  it("a v2 receipt with an authentic body and legalBasis passes, and the note names the version", async () => {
    const result = await disclosureCopyOf(baseReceipt());
    expect(result.disclosureCopy).toBe("pass");
    expect(result.notes.join("\n")).toContain("disclosureVersion 2");
  });

  it("a v2 receipt with one tampered justificationFr FAILS", async () => {
    const receipt = receiptWith((consent) => {
      (consent["legalBasis"] as Record<string, Record<string, string>>)["0x01"]!["justificationFr"] =
        "Consentement obtenu de force.";
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("disclosureVersion 2");
  });

  it("a v2 receipt whose disclosure body was tampered FAILS", async () => {
    const tampered = structuredClone(IPFS_BODY) as typeof IPFS_BODY;
    tampered.disclosure.purpose.en = "Marketing, shared with partners.";
    const result = await disclosureCopyOf(baseReceipt(), tampered);
    expect(result.disclosureCopy).toBe("fail");
  });

  it("a v2 receipt with NO legalBasis FAILS, and never falls back to the v1 formula", async () => {
    // The hash here is the v1 formula over the disclosure alone: a fallback would wrongly pass it.
    const receipt = receiptWith((consent) => {
      delete consent["legalBasis"];
      consent["disclosureHash"] = sha256Of(DISCLOSURE);
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("carries no legalBasis");
  });

  it("a v2 body that carries a legalBasis differing from the receipt's FAILS", async () => {
    const body = { ...IPFS_BODY, legalBasis: { "0x01": { basis: "consent", justificationFr: "" } } };
    const result = await disclosureCopyOf(baseReceipt(), body);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("differs from the receipt's");
  });

  it("a v2 body that carries the same legalBasis as the receipt still passes", async () => {
    const body = { ...IPFS_BODY, legalBasis: structuredClone(LEGAL_BASIS) };
    const result = await disclosureCopyOf(baseReceipt(), body);
    expect(result.disclosureCopy).toBe("pass");
  });

  it("a legalBasis without disclosureVersion 2 FAILS, the preimage being ambiguous", async () => {
    const receipt = receiptWith((consent) => {
      consent["disclosureVersion"] = "1";
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("fail");
  });

  it("an unknown disclosureVersion FAILS", async () => {
    const receipt = receiptWith((consent) => {
      consent["disclosureVersion"] = "3";
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("unknown disclosureVersion");
  });

  it("a v1 receipt (no legalBasis, no disclosureVersion) still passes on the disclosure alone", async () => {
    const receipt = receiptWith((consent) => {
      delete consent["legalBasis"];
      delete consent["disclosureVersion"];
      consent["disclosureHash"] = sha256Of(DISCLOSURE);
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("pass");
  });

  it("an explicit disclosureVersion 1 with no legalBasis still passes", async () => {
    const receipt = receiptWith((consent) => {
      delete consent["legalBasis"];
      consent["disclosureVersion"] = "1";
      consent["disclosureHash"] = sha256Of(DISCLOSURE);
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("pass");
  });
});

describe("a value the canonicalizer refuses is a verdict, never a throw out of verifyReceipt", () => {
  // A number is the one value the JCS canonicalizer refuses here (numbers travel as strings).
  it("a v2 legalBasis holding a number FAILS the disclosure check, with the reason, and does not throw", async () => {
    const receipt = receiptWith((consent) => {
      (consent["legalBasis"] as Record<string, Record<string, unknown>>)["0x01"]!["weight"] = 3;
    });
    const result = await disclosureCopyOf(receipt);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("the receipt's legalBasis cannot be canonicalized");
  });

  it("a v2 IPFS body carrying a legalBasis with a number FAILS the disclosure check, and does not throw", async () => {
    const body = { ...IPFS_BODY, legalBasis: { "0x01": { basis: "consent", weight: 3 } } };
    const result = await disclosureCopyOf(baseReceipt(), body);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("the IPFS document body cannot be canonicalized");
  });

  it("a v2 IPFS body whose disclosure holds a number FAILS the disclosure check, and does not throw", async () => {
    const body = { ...IPFS_BODY, disclosure: { ...DISCLOSURE, copies: 3 } };
    const result = await disclosureCopyOf(baseReceipt(), body);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("the IPFS document body cannot be canonicalized");
  });

  it("a v1 IPFS body whose disclosure holds a number FAILS the disclosure check, and does not throw", async () => {
    const receipt = receiptWith((consent) => {
      delete consent["legalBasis"];
      delete consent["disclosureVersion"];
      consent["disclosureHash"] = sha256Of(DISCLOSURE);
    });
    const body = { ...IPFS_BODY, disclosure: { ...DISCLOSURE, copies: 3 } };
    const result = await disclosureCopyOf(receipt, body);
    expect(result.disclosureCopy).toBe("fail");
    expect(result.notes.join("\n")).toContain("the IPFS document body cannot be canonicalized");
  });
});
