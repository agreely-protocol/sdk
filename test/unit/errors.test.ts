import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyAuthError,
  AgreelyBillingInactiveError,
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyRateLimitError,
  AgreelyVerbalDailyCapError,
  type AgreelyErrorReason,
  AgreelyNotFoundError,
  AgreelyUnavailableError,
  AgreelyValidationError,
} from "../../src/index.js";
import { abortError, mockFetch, networkError } from "./helpers.js";

const BASE = "http://api.test";
function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

describe("typed errors", () => {
  it("401 -> AgreelyAuthError", async () => {
    const { agreely } = client([{ status: 401, json: { error: { code: "unauthorized", message: "no key" } } }]);
    await expect(agreely.catalog.list()).rejects.toBeInstanceOf(AgreelyAuthError);
  });

  it("403 -> AgreelyAuthError with the wire code", async () => {
    const { agreely } = client([{ status: 403, json: { error: { code: "forbidden", message: "scope" } } }]);
    await expect(agreely.catalog.list()).rejects.toMatchObject({
      name: "AgreelyAuthError",
      code: "forbidden",
      status: 403,
    });
  });

  it("422 -> AgreelyValidationError carrying the field", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "invalid_request", message: "bad", field: "purpose" } } },
    ]);
    await expect(agreely.checkDetailed("c", "cat", "")).rejects.toMatchObject({
      name: "AgreelyValidationError",
      field: "purpose",
    });
  });

  it("400 -> AgreelyValidationError", async () => {
    const { agreely } = client([{ status: 400, json: { error: { code: "invalid_request", message: "bad" } } }]);
    await expect(agreely.consentRequests.list()).rejects.toBeInstanceOf(AgreelyValidationError);
  });

  it("404 -> AgreelyNotFoundError", async () => {
    const { agreely } = client([{ status: 404, json: { error: { code: "not_found", message: "gone" } } }]);
    await expect(agreely.consentRequests.get("0xabc")).rejects.toBeInstanceOf(AgreelyNotFoundError);
  });

  it("402 -> AgreelyBillingInactiveError with the wire code", async () => {
    const { agreely } = client([
      { status: 402, json: { error: { code: "billing_inactive", message: "subscription lapsed" } } },
    ]);
    // toBeInstanceOf, like every sibling here: toMatchObject alone would also pass for a
    // plain object that merely carries the right `name`, so it never proved the typed
    // class was thrown. The unused import was the tell.
    const error = await agreely.checkDetailed("c", "cat", "pur").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgreelyBillingInactiveError);
    expect(error).toMatchObject({ code: "billing_inactive", status: 402 });
  });

  it("429 -> AgreelyRateLimitError exposing retryAfter from the header", async () => {
    const { agreely } = client([
      {
        status: 429,
        headers: { "Retry-After": "42" },
        json: { error: { code: "rate_limited", message: "slow down" } },
      },
    ]);
    await expect(agreely.catalog.list()).rejects.toMatchObject({
      name: "AgreelyRateLimitError",
      retryAfter: 42,
    });
  });

  it("503 -> AgreelyUnavailableError (and surfaces from checkDetailed)", async () => {
    const { agreely } = client([
      { status: 503, json: { error: { code: "unavailable", message: "down" } } },
      { status: 503, json: { error: { code: "unavailable", message: "down" } } },
    ]);
    await expect(agreely.checkDetailed("c", "cat", "pur")).rejects.toBeInstanceOf(AgreelyUnavailableError);
  });

  it("a network error becomes AgreelyUnavailableError", async () => {
    const { agreely } = client([{ throw: networkError() }, { throw: networkError() }]);
    await expect(agreely.checkDetailed("c", "cat", "pur")).rejects.toBeInstanceOf(AgreelyUnavailableError);
  });

  it("a timeout (abort) becomes AgreelyUnavailableError", async () => {
    const { agreely } = client([{ throw: abortError() }, { throw: abortError() }]);
    await expect(agreely.checkDetailed("c", "cat", "pur")).rejects.toBeInstanceOf(AgreelyUnavailableError);
  });
});

describe("the stable reason and field", () => {
  it("carries error.reason and error.field on every status that sends them", async () => {
    const { agreely } = client([
      {
        status: 409,
        json: { error: { code: "conflict", message: "Reworded at will.", field: "effectiveDate", reason: "predates_withdrawal" } },
      },
    ]);
    const err = await agreely.manualConsents.revoke("0x" + "a".repeat(64)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect(err).toMatchObject({ reason: "predates_withdrawal", field: "effectiveDate", status: 409 });
  });

  it("passes an unknown future reason through untouched (the type is open-ended)", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "invalid_request", message: "new", reason: "some_future_reason" } } },
    ]);
    const err = await agreely.catalog.list().catch((e: unknown) => e);
    const reason: AgreelyErrorReason | undefined = (err as AgreelyValidationError).reason;
    expect(reason).toBe("some_future_reason");
  });

  it("leaves reason undefined when the envelope carries none, or a non-string", async () => {
    const { agreely } = client([
      { status: 404, json: { error: { code: "not_found", message: "gone" } } },
      { status: 422, json: { error: { code: "invalid_request", message: "bad", reason: 7, field: ["x"] } } },
    ]);
    await expect(agreely.catalog.list()).rejects.toMatchObject({ reason: undefined });
    await expect(agreely.catalog.list()).rejects.toMatchObject({ reason: undefined, field: undefined });
  });

  it("types every daily cap apart from the per-minute window", async () => {
    const { agreely } = client([
      { status: 429, json: { error: { code: "verbal_daily_cap", message: "cap", reason: "daily_cap" } } },
      { status: 429, headers: { "Retry-After": "5" }, json: { error: { code: "rate_limited", message: "slow" } } },
    ]);
    const verbal = await agreely.catalog.list().catch((e: unknown) => e);
    expect(verbal).toBeInstanceOf(AgreelyVerbalDailyCapError);
    expect(verbal).toBeInstanceOf(AgreelyDailyCapError);
    expect(verbal).toMatchObject({ code: "verbal_daily_cap", reason: "daily_cap" });
    const window = await agreely.catalog.list().catch((e: unknown) => e);
    expect(window).toBeInstanceOf(AgreelyRateLimitError);
    expect(window).not.toBeInstanceOf(AgreelyDailyCapError);
  });
});
