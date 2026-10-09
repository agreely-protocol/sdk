import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyNotFoundError,
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
  assurance: "company_attested",
  gate: "denied",
  alsoWithdrawn: [OTHER],
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

  it("sends a Date requestedAt in UTC, omits absent optionals, and keeps nothing else from the input", async () => {
    const { agreely, calls } = client([{ json: withdrawn }, { json: withdrawn }]);
    await agreely.withdrawals.record("c1", REF, { ...input, requestedAt: new Date("2026-10-08T18:05:00Z") });
    await agreely.withdrawals.record("c1", REF, { ...input, company: "other" } as never, { idempotencyKey: "w-1" });
    expect(calls[0]!.body).toEqual({ ...input, requestedAt: "2026-10-08T18:05:00.000Z" });
    expect(calls[1]!.body).toEqual(input);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe("w-1");
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
});
