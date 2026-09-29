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
    expect(() => agreely.manualConsents.record(input, { idempotencyKey: "has space" })).toThrow(AgreelyConfigError);
    expect(() => agreely.manualConsents.record(input, { idempotencyKey: "" })).toThrow(AgreelyConfigError);
    expect(() => agreely.manualConsents.record(input, { idempotencyKey: "k".repeat(256) })).toThrow(AgreelyConfigError);
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

  it("erases by consentRef", async () => {
    const { agreely, calls } = client([{ json: { consentRef: REF, erased: true, alreadyErased: false } }]);
    const r = await agreely.manualConsents.erase(REF);
    expect(calls[0]!.url).toBe(`${BASE}/v1/manual-consents/${REF}/erase`);
    expect(r).toEqual({ consentRef: REF, erased: true, alreadyErased: false });
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
