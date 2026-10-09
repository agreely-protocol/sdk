import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyAuthError,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyRateLimitError,
  AgreelyValidationError,
  AgreelyVerbalDailyCapError,
} from "../../src/index.js";
import type { RecordVerbalConsentInput } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REF = "0x" + "a".repeat(64);
const SHA = "0x" + "f".repeat(64);

function client(script: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch, ...extra }), calls };
}

const input: RecordVerbalConsentInput = {
  customerId: "c1",
  documentVersionId: "11111111-2222-3333-4444-555555555555",
  answers: [
    { category: "Coordonnees", purpose: "Infolettre", answer: "yes" },
    { category: "Coordonnees", purpose: "Sondages", answer: "no" },
  ],
  obtainedAt: "2026-09-29T10:05:00-04:00",
  obtainedBy: "Julie, service client",
  scriptVersion: "script-2026.09",
  respondent: { consentedBy: "self" },
  validUntil: "2027-09-29",
};

const recorded = {
  consentId: ID,
  merkleRoot: "0x" + "1".repeat(64),
  consentRefs: [REF],
  tier: "verbal",
  assurance: "company_documented",
  anchored: false,
  paperExpected: false,
  acknowledged: [],
  asksDeclined: false,
};

describe("verbalConsents.record", () => {
  it("posts every answer explicitly and returns the verbal tier, never overstated", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    const r = await agreely.verbalConsents.record(input);
    expect(calls[0]!.url).toBe(`${BASE}/v1/verbal-consents`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      customerId: "c1",
      documentVersionId: "11111111-2222-3333-4444-555555555555",
      answers: input.answers,
      obtainedAt: "2026-09-29T10:05:00-04:00",
      obtainedBy: "Julie, service client",
      scriptVersion: "script-2026.09",
      respondent: { consentedBy: "self" },
      validUntil: "2027-09-29",
    });
    expect(r.tier).toBe("verbal");
    expect(r.assurance).toBe("company_documented");
  });

  it("sends a minor's representative, isMinor, paperExpected and the express attestation", async () => {
    const { agreely, calls } = client([{ status: 201, json: { ...recorded, paperExpected: true } }]);
    await agreely.verbalConsents.record({
      ...input,
      respondent: { consentedBy: "representative", representativeCapacity: "titulaire_autorite_parentale", name: "Marie Tremblay" },
      isMinor: true,
      paperExpected: true,
      sensitiveExpressAttested: true,
      validUntil: new Date("2027-01-01T05:00:00Z"),
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.respondent).toEqual({
      consentedBy: "representative",
      representativeCapacity: "titulaire_autorite_parentale",
      name: "Marie Tremblay",
    });
    expect(body.isMinor).toBe(true);
    expect(body.paperExpected).toBe(true);
    expect(body.sensitiveExpressAttested).toBe(true);
    expect(body.validUntil).toBe("2027-01-01T05:00:00.000Z");
  });

  it("sends a Date obtainedAt in UTC and refuses a naive timestamp before any call", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    await agreely.verbalConsents.record({ ...input, obtainedAt: new Date("2026-09-29T14:05:00Z") });
    expect((calls[0]!.body as { obtainedAt: string }).obtainedAt).toBe("2026-09-29T14:05:00.000Z");
    await expect(agreely.verbalConsents.record({ ...input, obtainedAt: "2026-09-29T10:05:00" })).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.verbalConsents.record({ ...input, obtainedAt: "yesterday" })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(1);
  });

  it("refuses an answer that is not exactly yes or no, and an empty answer list", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    const boolAnswer = [{ category: "A", purpose: "B", answer: true }] as unknown as RecordVerbalConsentInput["answers"];
    await expect(agreely.verbalConsents.record({ ...input, answers: boolAnswer })).rejects.toThrow(AgreelyConfigError);
    const informed = [{ category: "A", purpose: "B", answer: "informed" }] as unknown as RecordVerbalConsentInput["answers"];
    await expect(agreely.verbalConsents.record({ ...input, answers: informed })).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.verbalConsents.record({ ...input, answers: [] })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("auto-generates a fresh Idempotency-Key, honors a valid override and refuses a malformed one", async () => {
    const { agreely, calls } = client([{ status: 201, json: recorded }]);
    await agreely.verbalConsents.record(input);
    await agreely.verbalConsents.record(input);
    await agreely.verbalConsents.record(input, { idempotencyKey: "call-2026-09-29-0001" });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^idem_/);
    expect(calls[0]!.headers["Idempotency-Key"]).not.toBe(calls[1]!.headers["Idempotency-Key"]);
    expect(calls[2]!.headers["Idempotency-Key"]).toBe("call-2026-09-29-0001");
    await expect(agreely.verbalConsents.record(input, { idempotencyKey: "é" })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(3);
  });

  it("surfaces the acknowledged information lines and asksDeclined", async () => {
    const ack = { category: "Coordonnees", purpose: "Gestion du dossier", consentRef: REF };
    const { agreely } = client([{ status: 201, json: { ...recorded, acknowledged: [ack], asksDeclined: true } }]);
    const r = await agreely.verbalConsents.record({
      ...input,
      answers: [{ category: "Coordonnees", purpose: "Infolettre", answer: "no" }],
    });
    expect(r.asksDeclined).toBe(true);
    expect(r.acknowledged).toEqual([ack]);
  });

  it("never retries (it mutates), even on a 503 with maxRetries set", async () => {
    const { agreely, calls } = client([{ status: 503 }, { status: 201, json: recorded }], { maxRetries: 3 });
    await expect(agreely.verbalConsents.record(input)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("maps the daily cap to AgreelyVerbalDailyCapError, a rate-limit subclass that is never retried", async () => {
    const { agreely, calls } = client(
      [
        { status: 429, json: { error: { code: "verbal_daily_cap", message: "Daily limit reached." } } },
        { status: 201, json: recorded },
      ],
      { maxRetries: 3 },
    );
    const err = await agreely.verbalConsents.record(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyVerbalDailyCapError);
    expect(err).toBeInstanceOf(AgreelyRateLimitError);
    expect((err as AgreelyVerbalDailyCapError).code).toBe("verbal_daily_cap");
    expect(calls).toHaveLength(1);
  });

  it("maps a covered purpose / stronger consent / ended relationship to AgreelyConflictError (code conflict)", async () => {
    const { agreely } = client([
      { status: 409, json: { error: { code: "conflict", message: "Already held by an active paper consent." } } },
    ]);
    const err = await agreely.verbalConsents.record(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect((err as AgreelyConflictError).code).toBe("conflict");
  });

  it("maps an answer on an information line to AgreelyValidationError (422)", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "invalid_request", message: "That line is given for information." } } },
    ]);
    await expect(agreely.verbalConsents.record(input)).rejects.toBeInstanceOf(AgreelyValidationError);
  });

  it("maps a key without attest_verbal to AgreelyAuthError (403)", async () => {
    const { agreely } = client([
      { status: 403, json: { error: { code: "forbidden", message: "This API key does not carry the 'attest_verbal' scope." } } },
    ]);
    await expect(agreely.verbalConsents.record(input)).rejects.toBeInstanceOf(AgreelyAuthError);
  });
});

describe("verbalConsents.confirmWithPaper", () => {
  const paper = {
    verbalConsentId: ID,
    manualConsentId: "99999999-8888-7777-6666-555555555555",
    merkleRoot: "0x" + "2".repeat(64),
    tier: "manual",
    confirmed: [{ category: "Coordonnees", purpose: "Infolettre", verbalConsentRef: REF, consentRef: "0x" + "b".repeat(64) }],
    withdrawn: [],
  };

  it("posts signedAt, the ticked answers and the evidence to the paper route", async () => {
    const { agreely, calls } = client([{ status: 201, json: paper }]);
    const r = await agreely.verbalConsents.confirmWithPaper(ID, {
      signedAt: "2026-10-02T09:00:00-04:00",
      answers: [{ category: "Coordonnees", purpose: "Infolettre", answer: "yes" }],
      evidence: { pdfSha256: SHA, pdf: "JVBERi0=" },
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/verbal-consents/${ID}/paper`);
    expect(calls[0]!.body).toEqual({
      signedAt: "2026-10-02T09:00:00-04:00",
      answers: [{ category: "Coordonnees", purpose: "Infolettre", answer: "yes" }],
      evidence: { pdfSha256: SHA, pdf: "JVBERi0=" },
    });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^idem_/);
    expect(r.tier).toBe("manual");
    expect(r.confirmed[0]!.verbalConsentRef).toBe(REF);
  });

  it("decodes an all-unticked paper: no manual consent, every purpose withdrawn", async () => {
    const allNo = {
      verbalConsentId: ID,
      manualConsentId: null,
      merkleRoot: null,
      tier: null,
      confirmed: [],
      withdrawn: [{ category: "Coordonnees", purpose: "Infolettre", consentRef: REF }],
    };
    const { agreely } = client([{ status: 201, json: allNo }]);
    const r = await agreely.verbalConsents.confirmWithPaper(ID, {
      signedAt: new Date("2026-10-02T13:00:00Z"),
      answers: [{ category: "Coordonnees", purpose: "Infolettre", answer: "no" }],
      evidence: { pdfSha256: SHA },
    });
    expect(r.manualConsentId).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.withdrawn).toHaveLength(1);
  });

  it("refuses a consentId that is not a uuid before any call", async () => {
    const { agreely, calls } = client([{ status: 201, json: paper }]);
    await expect(agreely.verbalConsents.confirmWithPaper("../manual-consents", {
        signedAt: "2026-10-02T09:00:00-04:00",
        answers: [{ category: "A", purpose: "B", answer: "yes" }],
        evidence: { pdfSha256: SHA },
      }),).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("maps a second paper to AgreelyConflictError", async () => {
    const { agreely } = client([
      { status: 409, json: { error: { code: "conflict", message: "The paper of this verbal consent was already recorded." } } },
    ]);
    const err = await agreely.verbalConsents
      .confirmWithPaper(ID, {
        signedAt: "2026-10-02T09:00:00-04:00",
        answers: [{ category: "A", purpose: "B", answer: "yes" }],
        evidence: { pdfSha256: SHA },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
  });
});

describe("verbalConsents.get", () => {
  it("reads the history, informed lines included, and retries a transient failure (it is a read)", async () => {
    const history = {
      consentId: ID,
      tier: "verbal",
      assurance: "company_documented",
      merkleRoot: "0x" + "1".repeat(64),
      anchored: true,
      obtainedAt: "2026-09-29T14:05:00Z",
      recordedAt: "2026-09-29T14:07:12Z",
      obtainedBy: "Julie, service client",
      scriptVersion: "script-2026.09",
      documentVersionId: "11111111-2222-3333-4444-555555555555",
      validUntil: "2027-09-30T03:59:59Z",
      paperExpected: true,
      state: "awaiting_paper",
      purposes: [
        { category: "Coordonnees", purpose: "Infolettre", answer: "yes", consentRef: REF, status: "active", paper: null, confirmedBy: null },
        { category: "Coordonnees", purpose: "Gestion du dossier", answer: "informed", consentRef: "0x" + "c".repeat(64), status: "active", paper: null, confirmedBy: null },
      ],
      paper: null,
    };
    const { agreely, calls } = client([{ status: 503 }, { json: history }]);
    const r = await agreely.verbalConsents.get(ID.toUpperCase());
    expect(calls[1]!.url).toBe(`${BASE}/v1/verbal-consents/${ID}`);
    expect(calls[1]!.method).toBe("GET");
    expect(r.state).toBe("awaiting_paper");
    expect(r.purposes[1]!.answer).toBe("informed");
  });
});
