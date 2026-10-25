import { describe, expect, it } from "vitest";
import { Agreely, AgreelyConfigError, AgreelyConflictError, AgreelyNotFoundError } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const REF = "0x" + "a".repeat(64);
const SHA = "0x" + "f".repeat(64);

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

const input = {
  customerId: "c1",
  documentVersionId: "doc-1",
  effectiveDate: "2026-06-01",
  validUntil: "2031-01-01",
  items: ["cat-id-1", { category: "Email", purpose: "News" }],
  evidence: { pdfSha256: SHA },
};
const recorded = {
  consentId: "mc_1",
  merkleRoot: "0x" + "1".repeat(64),
  consentRefs: [REF],
  assurance: "company_attested",
  anchored: false,
  acknowledged: [],
  asksDeclined: false,
};

describe("manualConsents.record (Idempotency-Key)", () => {
  it("auto-generates a unique Idempotency-Key per call", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }, { status: 201, json: recorded }]);
    await agreely.manualConsents.record(input);
    await agreely.manualConsents.record(input);
    const k1 = calls[0]!.headers["Idempotency-Key"];
    const k2 = calls[1]!.headers["Idempotency-Key"];
    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();
    expect(k1).not.toBe(k2);
  });

  it("honors an overridden Idempotency-Key (so a retry replays, not double-records)", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    await agreely.manualConsents.record(input, { idempotencyKey: "my-key-123" });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("my-key-123");
  });

  it("sends items RAW and the pdfSha256 commitment, WITHOUT pdf bytes by default", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    await agreely.manualConsents.record(input);
    expect(calls[0]!.url).toBe(`${BASE}/v1/manual-consents`);
    expect(calls[0]!.body).toMatchObject({
      customerId: "c1",
      documentVersionId: "doc-1",
      effectiveDate: "2026-06-01",
      validUntil: "2031-01-01",
      items: ["cat-id-1", { category: "Email", purpose: "News" }],
      evidence: { pdfSha256: SHA },
    });
    expect((calls[0]!.body as { evidence: { pdf?: string } }).evidence.pdf).toBeUndefined();
  });

  it("uploads the pdf bytes only when evidence.pdf is provided", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    await agreely.manualConsents.record({ ...input, evidence: { pdfSha256: SHA, pdf: "YmFzZTY0" } });
    expect((calls[0]!.body as { evidence: { pdf?: string } }).evidence.pdf).toBe("YmFzZTY0");
  });

  it("returns the company-attested result with its consentRefs", async () => {
    const { agreely } = client([{ status: 201, json: recorded }]);
    const r = await agreely.manualConsents.record(input);
    expect(r.assurance).toBe("company_attested");
    expect(r.anchored).toBe(false);
    expect(r.consentRefs).toEqual([REF]);
  });

  it("does NOT retry on a 503 (record mutates)", async () => {
    const { agreely, calls } = client([{ status: 503 }, { status: 201, json: recorded }]);
    await expect(agreely.manualConsents.record(input)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("manualConsents.record (asks, information lines, refusals)", () => {
  it("sends an EMPTY items list (every ask answered no) and surfaces acknowledged + asksDeclined", async () => {
    const declined = {
      ...recorded,
      consentRefs: [REF],
      acknowledged: [{ category: "Coordonnees", purpose: "Gestion du dossier", consentRef: REF }],
      asksDeclined: true,
    };
    const { agreely, calls } = client([{ status: 201, json: declined }]);
    const r = await agreely.manualConsents.record({ ...input, items: [] });
    expect((calls[0]!.body as { items: unknown[] }).items).toEqual([]);
    expect(r.asksDeclined).toBe(true);
    expect(r.acknowledged).toEqual([{ category: "Coordonnees", purpose: "Gestion du dossier", consentRef: REF }]);
  });

  it("refuses a malformed idempotencyKey override before any call", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    await expect(agreely.manualConsents.record(input, { idempotencyKey: "has space" })).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.manualConsents.record(input, { idempotencyKey: "" })).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.manualConsents.record(input, { idempotencyKey: "k".repeat(256) })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("maps a 409 conflict (a verbal consent awaits its paper) to AgreelyConflictError with code conflict", async () => {
    const { agreely } = client([
      { status: 409, json: { error: { code: "conflict", message: "A verbal consent awaits its paper." } } },
    ]);
    const err = await agreely.manualConsents.record(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect((err as AgreelyConflictError).code).toBe("conflict");
    expect((err as AgreelyConflictError).status).toBe(409);
  });
});

describe("manualConsents.createClaimLink", () => {
  const link = { claimUrl: "https://x/claim/abc", token: "tok_abc", expiresAt: "2026-07-01T00:00:00Z" };

  it("posts the customer and returns the claim link", async () => {
    const { agreely, calls } = client([{ status: 201, json: link }]);
    const r = await agreely.manualConsents.createClaimLink({ customerId: "c1" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/manual-consents/claim-links`);
    expect(calls[0]!.body).toEqual({ customerId: "c1" });
    expect(r).toEqual(link);
  });

  it("includes an optional reference when provided", async () => {
    const { agreely, calls } = client([{ status: 201, json: link }]);
    await agreely.manualConsents.createClaimLink({ customerId: "c1", reference: "order-99" });
    expect(calls[0]!.body).toEqual({ customerId: "c1", reference: "order-99" });
  });

  it("an unknown customer is AgreelyNotFoundError; an ended relationship is AgreelyConflictError", async () => {
    const { agreely } = client([
      { status: 404, json: { error: { code: "not_found", message: "No customer with that reference." } } },
      { status: 409, json: { error: { code: "conflict", message: "The relationship has ended." } } },
    ]);
    await expect(agreely.manualConsents.createClaimLink({ customerId: "ghost" })).rejects.toBeInstanceOf(AgreelyNotFoundError);
    const err = await agreely.manualConsents.createClaimLink({ customerId: "c1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect((err as AgreelyConflictError).code).toBe("conflict");
  });
});

describe("manualConsents.revoke / erase", () => {
  it("revokes by consentRef and forwards the reason", async () => {
    const { agreely, calls } = client([{ json: { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "denied" } }]);
    const r = await agreely.manualConsents.revoke(REF, { reason: "withdrawn" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/manual-consents/${REF}/revoke`);
    expect(calls[0]!.body).toEqual({ reason: "withdrawn" });
    expect(r).toEqual({ consentRef: REF, revoked: true, alreadyRevoked: false, gate: "denied" });
  });

  it("revoke is idempotent (alreadyRevoked true and gate unchanged on a repeat)", async () => {
    const { agreely } = client([{ json: { consentRef: REF, revoked: true, alreadyRevoked: true, gate: "unchanged" } }]);
    const r = await agreely.manualConsents.revoke(REF);
    expect(r.alreadyRevoked).toBe(true);
    expect(r.gate).toBe("unchanged");
  });

  it("surfaces gate superseded: a later consent still backs the purpose", async () => {
    const { agreely } = client([{ json: { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "superseded" } }]);
    const r = await agreely.manualConsents.revoke(REF);
    expect(r.gate).toBe("superseded");
  });

  it("erases by consentRef and reports the gate", async () => {
    const erased = { consentRef: REF, erased: true, alreadyErased: false, gate: "denied" };
    const { agreely, calls } = client([{ json: erased }]);
    const r = await agreely.manualConsents.erase(REF);
    expect(calls[0]!.url).toBe(`${BASE}/v1/manual-consents/${REF}/erase`);
    expect(r).toEqual(erased);
    expect(r.gate).toBe("denied");
  });

  it("surfaces citizen_consent_at_gate as a 409 with its reason: a passkey consent holds the purpose", async () => {
    const { agreely } = client([
      {
        status: 409,
        json: { error: { code: "conflict", message: "A consent the person signed online holds this purpose.", reason: "citizen_consent_at_gate" } },
      },
    ]);
    const err = await agreely.manualConsents.revoke(REF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect(err).toMatchObject({ code: "conflict", reason: "citizen_consent_at_gate", status: 409 });
  });

  it("sends otherConsents 'keep' or 'withdraw' verbatim on revoke and erase, beside the reason", async () => {
    const { agreely, calls } = client([
      { json: { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "superseded", stillInForce: true } },
      { json: { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "superseded", stillInForce: true } },
      { json: { consentRef: REF, erased: true, alreadyErased: false, gate: "superseded", stillInForce: true } },
      { json: { consentRef: REF, erased: true, alreadyErased: false, gate: "denied" } },
    ]);
    await agreely.manualConsents.revoke(REF, { reason: "asked", otherConsents: "keep" });
    await agreely.manualConsents.revoke(REF, { otherConsents: "withdraw" });
    await agreely.manualConsents.erase(REF, { otherConsents: "keep" });
    await agreely.manualConsents.erase(REF);
    expect(calls.map((c) => c.body)).toEqual([
      { reason: "asked", otherConsents: "keep" },
      { otherConsents: "withdraw" },
      { otherConsents: "keep" },
      {},
    ]);
  });

  it("returns stillInForce true when kept, and omits it when nothing was kept (as the server does)", async () => {
    const kept = { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "superseded", stillInForce: true };
    const plain = { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "denied" };
    const { agreely } = client([{ json: kept }, { json: plain }]);
    const a = await agreely.manualConsents.revoke(REF, { otherConsents: "keep" });
    const b = await agreely.manualConsents.revoke(REF);
    expect(a.stillInForce).toBe(true);
    expect(b).not.toHaveProperty("stillInForce");
  });

  it("refuses an otherConsents other than 'keep' or 'withdraw', and an input member it does not name, before any call", async () => {
    const { agreely, calls } = client([{ json: { consentRef: REF, revoked: true, alreadyRevoked: false, gate: "denied" } }]);
    await expect(agreely.manualConsents.revoke(REF, { otherConsents: "KEEP" } as never)).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.manualConsents.erase(REF, { otherConsents: true } as never)).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.manualConsents.revoke(REF, { otherConsent: "keep" } as never)).rejects.toThrow(/unknown member/);
    expect(calls).toHaveLength(0);
  });
});

describe("manualConsents.record (attestations)", () => {
  it("sends sensitiveExpressAttested and versionAttested as JSON booleans, only when given", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }, { status: 201, json: recorded }]);
    await agreely.manualConsents.record({ ...input, sensitiveExpressAttested: true, versionAttested: false });
    await agreely.manualConsents.record(input);
    expect(calls[0]!.body).toMatchObject({ sensitiveExpressAttested: true, versionAttested: false });
    expect(calls[1]!.body).not.toHaveProperty("sensitiveExpressAttested");
    expect(calls[1]!.body).not.toHaveProperty("versionAttested");
  });

  it("refuses a loose value (never read as a yes) before any call", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    const loose = { ...input, versionAttested: "true" as unknown as boolean };
    await expect(agreely.manualConsents.record(loose)).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the stable reason and field of a refusal", async () => {
    const { agreely } = client([
      {
        status: 422,
        json: {
          error: {
            code: "invalid_request",
            message: "The paper predates the version.",
            field: "versionAttested",
            reason: "version_attestation_required",
          },
        },
      },
    ]);
    const err = await agreely.manualConsents.record(input).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "version_attestation_required", field: "versionAttested" });
  });
});

describe("manualConsents.createConsentSheet", () => {
  const VERSION = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
  const sheet = {
    signatureSheet: {
      documentVersionId: VERSION,
      locale: "fr",
      contentType: "application/pdf",
      filename: "agreely-feuille-signature.pdf",
      pdf: Buffer.from("%PDF-1.7").toString("base64"),
    },
    printedReference: "ABCD-EFGH",
    claim: { claimUrl: "https://x/claim/abc", token: "tok_abc", expiresAt: "2026-11-01T00:00:00Z" },
  };

  it("posts to the customer's path, encoded, with the two documented members and an Idempotency-Key", async () => {
    const { agreely, calls } = client([{ status: 201, json: sheet }]);
    const r = await agreely.manualConsents.createConsentSheet("STORE/0042", { documentVersionId: VERSION });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042/consent-sheets`);
    expect(calls[0]!.body).toEqual({ documentVersionId: VERSION, locale: "fr" });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^idem_/);
    expect(r.printedReference).toBe("ABCD-EFGH");
    expect(Buffer.from(r.signatureSheet.pdf, "base64").toString()).toBe("%PDF-1.7");
  });

  it("sends nothing else on the input object, and honours locale and an overridden key", async () => {
    const { agreely, calls } = client([{ status: 201, json: sheet }]);
    const extra = { documentVersionId: VERSION, locale: "en", printedReference: "MINE" } as never;
    await agreely.manualConsents.createConsentSheet("c1", extra, { idempotencyKey: "sheet-c1-1" });
    expect(calls[0]!.body).toEqual({ documentVersionId: VERSION, locale: "en" });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("sheet-c1-1");
  });

  it("refuses a blank customerRef, a missing version or a bad locale before any call", async () => {
    const { agreely, calls } = client([{ status: 201, json: sheet }]);
    await expect(agreely.manualConsents.createConsentSheet(" ", { documentVersionId: VERSION })).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.manualConsents.createConsentSheet("c1", { documentVersionId: "" })).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.manualConsents.createConsentSheet("c1", { documentVersionId: VERSION, locale: "de" as "fr" }),).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("a replayed key is a 409 already_minted (the reference is never returned twice), never retried", async () => {
    const { agreely, calls } = client([
      { status: 409, json: { error: { code: "already_minted", message: "Already minted.", reason: "already_minted" } } },
    ]);
    const err = await agreely.manualConsents
      .createConsentSheet("c1", { documentVersionId: VERSION }, { idempotencyKey: "sheet-c1-1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect(err).toMatchObject({ code: "already_minted", reason: "already_minted" });
    expect(calls).toHaveLength(1);
  });

  it("an unknown customer is a 404 with reason unknown_customer; a notice-only version is no_consent_ask", async () => {
    const { agreely } = client([
      { status: 404, json: { error: { code: "not_found", message: "No customer.", reason: "unknown_customer" } } },
      {
        status: 422,
        json: {
          error: { code: "no_consent_ask", message: "Nothing to sign.", field: "documentVersionId", reason: "notice_only" },
        },
      },
    ]);
    await expect(agreely.manualConsents.createConsentSheet("ghost", { documentVersionId: VERSION })).rejects.toMatchObject({
      name: "AgreelyNotFoundError",
      reason: "unknown_customer",
    });
    await expect(agreely.manualConsents.createConsentSheet("c1", { documentVersionId: VERSION })).rejects.toMatchObject({
      name: "AgreelyValidationError",
      code: "no_consent_ask",
      reason: "notice_only",
      field: "documentVersionId",
    });
  });
});

describe("check() surfaces the assurance field", () => {
  it("carries assurance through checkDetailed when present", async () => {
    const { agreely } = client([
      { json: { decision: "allow", status: "active", consentRef: REF, assurance: "company_attested", checkedAt: "t" } },
    ]);
    const r = await agreely.checkDetailed("c1", "Email", "News");
    expect(r.assurance).toBe("company_attested");
  });

  it("leaves assurance undefined for status none", async () => {
    const { agreely } = client([{ json: { decision: "deny", status: "none", checkedAt: "t" } }]);
    const r = await agreely.checkDetailed("c1", "Email", "News");
    expect(r.assurance).toBeUndefined();
  });
});
