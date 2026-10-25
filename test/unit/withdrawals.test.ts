import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyNotFoundError,
  AgreelyOtherConsentsRunningError,
  AgreelyRateLimitError,
  AgreelyValidationError,
  WITHDRAWAL_CHANNELS,
  type ConsentWithdrawal,
} from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const REF = "0x" + "a".repeat(64);
const OTHER = "0x" + "b".repeat(64);

function client(script: Parameters<typeof mockFetch>[0], maxRetries?: number) {
  const { fetch, calls } = mockFetch(script);
  return {
    agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch, ...(maxRetries ? { maxRetries } : {}) }),
    calls,
  };
}

const withdrawn: ConsentWithdrawal = {
  consentRef: REF,
  withdrawn: true,
  alreadyWithdrawn: false,
  recordedOnBehalf: true,
  assurance: "company_documented",
  gate: "denied",
  alsoWithdrawn: [OTHER],
  stillInForce: [],
};

const input = { channel: "phone", operator: "agent-042" } as const;

describe("withdrawals.record", () => {
  it("posts to the customer's consent, encoded, with the named fields and an Idempotency-Key", async () => {
    const { agreely, calls } = client([{ json: withdrawn }]);
    const r = await agreely.withdrawals.record("STORE/0042", REF, {
      ...input,
      requestedAt: "2026-10-08T14:05:00-04:00",
      reason: "Asked by phone",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042/consents/${REF}/withdrawal`);
    expect(calls[0]!.body).toEqual({
      channel: "phone",
      operator: "agent-042",
      requestedAt: "2026-10-08T14:05:00-04:00",
      reason: "Asked by phone",
    });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^idem_/);
    expect(r).toEqual(withdrawn);
    expect(r.alsoWithdrawn).toEqual([OTHER]);
  });

  it("sends a Date requestedAt in UTC and omits absent optionals", async () => {
    const { agreely, calls } = client([{ json: withdrawn }, { json: withdrawn }]);
    await agreely.withdrawals.record("c1", REF, { ...input, requestedAt: new Date("2026-10-08T18:05:00Z") });
    await agreely.withdrawals.record("c1", REF, input, { idempotencyKey: "w-1" });
    expect(calls[0]!.body).toEqual({ ...input, requestedAt: "2026-10-08T18:05:00.000Z" });
    expect(calls[1]!.body).toEqual(input);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe("w-1");
  });

  it("refuses an input member it does not name, before any call (never dropped silently)", async () => {
    const { agreely, calls } = client([{ json: withdrawn }]);
    await expect(agreely.withdrawals.record("c1", REF, { ...input, company: "other" } as never)).rejects.toThrow(
      /unknown member "company"/,
    );
    await expect(agreely.withdrawals.record("c1", REF, { ...input, otherConsent: "keep" } as never)).rejects.toThrow(
      AgreelyConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("accepts every documented channel", async () => {
    expect(WITHDRAWAL_CHANNELS).toEqual(["phone", "email", "mail", "in_person", "other"]);
    const { agreely, calls } = client([{ json: withdrawn }]);
    for (const channel of WITHDRAWAL_CHANNELS) {
      await agreely.withdrawals.record("c1", REF, { channel, operator: "op" });
    }
    expect(calls.map((c) => (c.body as { channel: string }).channel)).toEqual([...WITHDRAWAL_CHANNELS]);
  });

  it("refuses, before any call, what the server would refuse", async () => {
    const { agreely, calls } = client([{ json: withdrawn }]);
    const bad: Array<[string, string, Record<string, unknown>]> = [
      [" ", REF, input],
      ["c1", "0xabc", input],
      ["c1", REF, { ...input, channel: "fax" }],
      ["c1", REF, { ...input, operator: "agent@example.com" }],
      ["c1", REF, { ...input, operator: "" }],
      ["c1", REF, { ...input, requestedAt: "2026-10-08T14:05:00" }],
      ["c1", REF, { ...input, reason: "x".repeat(1001) }],
    ];
    for (const [customer, consent, body] of bad) {
      await expect(agreely.withdrawals.record(customer, consent, body as never)).rejects.toThrow(AgreelyConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  it("an unknown, foreign or other customer's reference is one 404 with reason unknown_consent", async () => {
    const { agreely } = client([
      { status: 404, json: { error: { code: "not_found", message: "No consent for that reference.", reason: "unknown_consent" } } },
    ]);
    const err = await agreely.withdrawals.record("c1", REF, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyNotFoundError);
    expect(err).toMatchObject({ reason: "unknown_consent" });
  });

  it("a lapsed consent is a 409 consent_lapsed; a cell that was never asked is a 422 not_revocable", async () => {
    const { agreely } = client([
      { status: 409, json: { error: { code: "conflict", message: "Ended on its own date.", reason: "consent_lapsed" } } },
      { status: 422, json: { error: { code: "invalid_request", message: "Not a consent ask.", reason: "not_revocable" } } },
    ]);
    await expect(agreely.withdrawals.record("c1", REF, input)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgreelyConflictError && e.reason === "consent_lapsed",
    );
    await expect(agreely.withdrawals.record("c1", REF, input)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgreelyValidationError && e.reason === "not_revocable",
    );
  });

  it("the daily cap is a typed AgreelyDailyCapError (code withdrawal_daily_cap, reason daily_cap), never retried", async () => {
    const { agreely, calls } = client(
      [
        { status: 429, json: { error: { code: "withdrawal_daily_cap", message: "Daily limit.", reason: "daily_cap" } } },
        { json: withdrawn },
      ],
      3,
    );
    const err = await agreely.withdrawals.record("c1", REF, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyDailyCapError);
    expect(err).toBeInstanceOf(AgreelyRateLimitError);
    expect(err).toMatchObject({ code: "withdrawal_daily_cap", reason: "daily_cap", retryAfterSeconds: undefined });
    expect(calls).toHaveLength(1);
  });

  it("the result is company_documented, never company_attested, and stillInForce is the list of refs left running", async () => {
    const { agreely } = client([
      { json: withdrawn },
      { json: { ...withdrawn, alsoWithdrawn: [], stillInForce: [OTHER] } },
    ]);
    const kept = await agreely.withdrawals.record("c1", REF, { ...input, otherConsents: "keep" });
    expect(kept.assurance).toBe("company_documented");
    expect(kept.stillInForce).toEqual([]);
    const after = await agreely.withdrawals.record("c1", REF, { ...input, otherConsents: "keep" });
    expect(after.stillInForce).toEqual([OTHER]);
  });
});

describe("withdrawals.record scope (otherConsents | alsoWithdraw)", () => {
  it("sends otherConsents 'withdraw' or 'keep' verbatim, and nothing when none is declared", async () => {
    const { agreely, calls } = client([{ json: withdrawn }, { json: withdrawn }, { json: withdrawn }]);
    await agreely.withdrawals.record("c1", REF, { ...input, otherConsents: "withdraw" });
    await agreely.withdrawals.record("c1", REF, { ...input, otherConsents: "keep" });
    await agreely.withdrawals.record("c1", REF, input);
    expect(calls.map((c) => c.body)).toEqual([
      { ...input, otherConsents: "withdraw" },
      { ...input, otherConsents: "keep" },
      input,
    ]);
  });

  it("sends alsoWithdraw as the trimmed list of refs, and [] as an empty list that declares nothing", async () => {
    const { agreely, calls } = client([{ json: withdrawn }, { json: withdrawn }]);
    await agreely.withdrawals.record("c1", REF, { ...input, alsoWithdraw: [` ${OTHER} `, REF] });
    await agreely.withdrawals.record("c1", REF, { ...input, alsoWithdraw: [] });
    expect(calls[0]!.body).toEqual({ ...input, alsoWithdraw: [OTHER, REF] });
    expect(calls[1]!.body).toEqual({ ...input, alsoWithdraw: [] });
  });

  it("accepts exactly 50 alsoWithdraw refs and refuses 51, before any call", async () => {
    const many = Array.from({ length: 50 }, (_, i) => "0x" + i.toString(16).padStart(64, "0"));
    const { agreely, calls } = client([{ json: withdrawn }]);
    await agreely.withdrawals.record("c1", REF, { ...input, alsoWithdraw: many });
    expect(calls[0]!.body).toMatchObject({ alsoWithdraw: many });
    await expect(
      agreely.withdrawals.record("c1", REF, { ...input, alsoWithdraw: [...many, OTHER] }),
    ).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(1);
  });

  it("refuses both otherConsents and alsoWithdraw together, even with an empty alsoWithdraw, before any call", async () => {
    const { agreely, calls } = client([{ json: withdrawn }]);
    await expect(
      agreely.withdrawals.record("c1", REF, { ...input, otherConsents: "keep", alsoWithdraw: [OTHER] }),
    ).rejects.toThrow(/never both/);
    await expect(
      agreely.withdrawals.record("c1", REF, { ...input, otherConsents: "withdraw", alsoWithdraw: [] }),
    ).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an otherConsents value other than 'withdraw' or 'keep', and an alsoWithdraw entry that is no consentRef", async () => {
    const { agreely, calls } = client([{ json: withdrawn }]);
    const bad: Array<Record<string, unknown>> = [
      { otherConsents: "KEEP" },
      { otherConsents: true },
      { otherConsents: null },
      { alsoWithdraw: "0x" + "c".repeat(64) },
      { alsoWithdraw: [OTHER, "0xabc"] },
      { alsoWithdraw: [42] },
    ];
    for (const scope of bad) {
      await expect(agreely.withdrawals.record("c1", REF, { ...input, ...scope } as never)).rejects.toThrow(
        AgreelyConfigError,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("the 422 other_consents_running is an AgreelyOtherConsentsRunningError exposing otherConsentRefs", async () => {
    const { agreely } = client([
      {
        status: 422,
        json: {
          error: {
            code: "invalid_request",
            message: "Other consents are in force for this purpose.",
            field: "otherConsents",
            reason: "other_consents_running",
            otherConsentRefs: [OTHER, REF],
          },
        },
      },
    ]);
    const err = await agreely.withdrawals.record("c1", REF, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyOtherConsentsRunningError);
    expect(err).toBeInstanceOf(AgreelyValidationError);
    expect(err).toMatchObject({
      code: "invalid_request",
      status: 422,
      field: "otherConsents",
      reason: "other_consents_running",
      otherConsentRefs: [OTHER, REF],
    });
  });

  it("other_consents_running without a list of refs still throws the class, with an empty otherConsentRefs", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "invalid_request", message: "x", reason: "other_consents_running" } } },
    ]);
    const err = await agreely.withdrawals.record("c1", REF, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyOtherConsentsRunningError);
    expect((err as AgreelyOtherConsentsRunningError).otherConsentRefs).toEqual([]);
  });
});
