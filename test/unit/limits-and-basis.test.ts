import { describe, expect, it } from "vitest";
import { Agreely, AgreelyConfigError, BATCH_CAP, RATE_LIMIT_PER_MINUTE } from "../../src/index.js";
import { mockFetch } from "./helpers.js";
import type { Basis, Status } from "../../src/types.js";

// The documented SERVER LIMITS (the 500-item batch cap) and the documented WIRE FIELDS
// the SDK previously dropped (`basis`, and the necessity / sensitive statuses).
//
// The cap assertions matter because the server's 422 decides NOTHING: an over-cap batch
// spends a request against the 120/minute allowance and comes back with no decisions at
// all, which a fail-closed caller must treat as an all-deny. Refusing client-side is
// strictly better, and it is the ONLY place the caller learns that checkFields
// multiplies refs by fields.

const BASE = "http://api.test";

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  const agreely = new Agreely({ apiKey: "agr_live_test", baseUrl: BASE, fetch });
  return { agreely, calls };
}

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    customerRef: `c${i}`,
    category: "Email",
    purpose: "Marketing",
  }));
}

describe("server limits are mirrored and enforced client-side", () => {
  it("names the limits the server actually enforces", () => {
    expect(BATCH_CAP).toBe(500);
    expect(RATE_LIMIT_PER_MINUTE).toBe(120);
  });

  it("sends a batch that is exactly AT the cap", async () => {
    const { agreely, calls } = client([{ json: { decisions: [] } }]);
    await agreely.checkBatch(items(BATCH_CAP));
    expect(calls).toHaveLength(1);
  });

  it("refuses an over-cap batch without touching the wire", async () => {
    const { agreely, calls } = client([{ json: { decisions: [] } }]);
    await expect(agreely.checkBatch(items(BATCH_CAP + 1))).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.checkBatch(items(BATCH_CAP + 1))).rejects.toThrow(/501 items.*cap of 500/s);
    expect(calls).toHaveLength(0);
  });

  // The cartesian-product trap: 100 rows x 6 fields is 600 cells, over the cap, on a
  // perfectly ordinary listing page. The error must name BOTH multiplicands and the safe
  // page size, because "500" alone does not tell the caller what to change.
  it("refuses an over-cap checkFields product and names both multiplicands", async () => {
    const { agreely, calls } = client([{ json: { decisions: [] } }]);
    const refs = Array.from({ length: 100 }, (_, i) => `cust-${i}`);
    const fields = [
      { category: "Email", purpose: "Marketing" },
      { category: "Phone", purpose: "Billing" },
      { category: "Address", purpose: "Delivery" },
      { category: "Health", purpose: "Claims" },
      { category: "Finance", purpose: "Pricing" },
      { category: "Location", purpose: "Telematics" },
    ];
    await expect(agreely.checkFields(refs, fields)).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.checkFields(refs, fields)).rejects.toThrow(
      /100 customerRefs x 6 fields = 600 cells.*at most 83 per call/s,
    );
    expect(calls).toHaveLength(0);
  });

  it("sends a checkFields product that is exactly AT the cap", async () => {
    const { agreely, calls } = client([{ json: { decisions: [] } }]);
    const refs = Array.from({ length: 250 }, (_, i) => `cust-${i}`);
    await agreely.checkFields(refs, [
      { category: "Email", purpose: "Marketing" },
      { category: "Phone", purpose: "Billing" },
    ]);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { items: unknown[] }).items).toHaveLength(500);
  });
});

describe("the documented status vocabulary and the `basis` field survive decode", () => {
  // A DECLARED-NECESSITY allow: allow / status "necessity" / basis, and NO consentRef and
  // NO assurance (there is no signed proof). Captured verbatim from the live local API,
  // which openapi.yaml documents and the SDK used to silently drop.
  it("surfaces the necessity basis on checkDetailed", async () => {
    const { agreely } = client([
      {
        json: {
          decision: "allow",
          status: "necessity",
          basis: "necessary_for_service",
          checkedAt: "2026-08-22T17:04:57Z",
        },
      },
    ]);
    const result = await agreely.checkDetailed("SDK-AUDIT-NOBODY-1", "Coordonnees", "Gestion du dossier client");

    expect(result.decision).toBe("allow");
    expect(result.status).toBe("necessity");
    expect(result.basis).toBe("necessary_for_service");
    expect(result.consentRef).toBeUndefined();
    expect(result.assurance).toBeUndefined();
  });

  it("leaves basis undefined on a consent-backed allow", async () => {
    const { agreely } = client([
      {
        json: {
          decision: "allow",
          status: "active",
          consentRef: "0xce324c62",
          assurance: "company_attested",
          checkedAt: "2026-08-22T17:05:55Z",
        },
      },
    ]);
    const result = await agreely.checkDetailed("c1", "Coordonnees", "Communications marketing");
    expect(result.basis).toBeUndefined();
    expect(result.assurance).toBe("company_attested");
  });

  it("surfaces the necessity basis on a batch decision", async () => {
    const { agreely } = client([
      {
        json: {
          decisions: [
            {
              customerRef: "SDK-AUDIT-0",
              category: "Coordonnees",
              purpose: "Gestion du dossier client",
              decision: "allow",
              status: "necessity",
              basis: "necessary_for_service",
              checkedAt: "2026-08-22T17:05:20Z",
            },
          ],
        },
      },
    ]);
    const decisions = await agreely.checkBatch([
      { customerRef: "SDK-AUDIT-0", category: "Coordonnees", purpose: "Gestion du dossier client" },
    ]);
    expect(decisions[0]!.status).toBe("necessity");
    expect(decisions[0]!.basis).toBe("necessary_for_service");
    expect(decisions[0]!.consentRef).toBeUndefined();
  });

  // The sensitive fail-closed status (shipped 2026-07-28) must survive decode and must
  // DENY. It was absent from the SDK vocabulary entirely.
  it("decodes sensitive_requires_consent and denies", async () => {
    const { agreely } = client([
      {
        json: {
          decision: "deny",
          status: "sensitive_requires_consent",
          checkedAt: "2026-08-22T17:04:57Z",
        },
      },
    ]);
    const result = await agreely.checkDetailed("c1", "Renseignements medicaux", "Evaluation des reclamations");
    expect(result.decision).toBe("deny");
    expect(result.status).toBe("sensitive_requires_consent");
  });

  // A compile-time assertion, not a runtime one: every status openapi.yaml declares must
  // be assignable to Status, and every basis to Basis. If either union drifts from the
  // spec, `npm run typecheck` fails here.
  it("types every status and basis openapi.yaml declares", () => {
    const statuses: Status[] = [
      "active",
      "necessity",
      "none",
      "revoked",
      "expired",
      "erased",
      "relationship_ended",
      "sensitive_requires_consent",
    ];
    const bases: Basis[] = [
      "contract",
      "necessary_for_service",
      "security_fraud",
      "legal_obligation",
      "professional_contact",
    ];
    expect(statuses).toHaveLength(8);
    expect(bases).toHaveLength(5);
  });
});
