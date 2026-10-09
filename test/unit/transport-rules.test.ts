import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyConfigError,
  AgreelyDailyCapError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelyUnavailableError,
  AgreelyVerbalDailyCapError,
} from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const HOLD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const REF = "0x" + "a".repeat(64);

function client(script: Parameters<typeof mockFetch>[0], maxRetries?: number) {
  const { fetch, calls } = mockFetch(script);
  return {
    agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch, ...(maxRetries ? { maxRetries } : {}) }),
    calls,
  };
}

function tooMany(code: string | undefined, reason?: string) {
  return {
    status: 429,
    headers: { "Retry-After": "0" },
    json: { error: { ...(code !== undefined ? { code } : {}), message: "cap", ...(reason ? { reason } : {}) } },
  };
}

// On a READ with maxRetries, so the only thing standing between a 429 and a retry is the
// classification. Deleting the exclusion in the transport turns these red.
describe("429 classification and retry, on an idempotent GET with maxRetries", () => {
  it("retries rate_limited (the positive control)", async () => {
    const { agreely, calls } = client([tooMany("rate_limited"), { json: { catalog: [] } }], 2);
    expect(await agreely.catalog.list()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 that carries no code at all (a proxy's), as the per-minute window", async () => {
    const { agreely, calls } = client([{ status: 429, headers: { "Retry-After": "0" } }, { json: { catalog: [] } }], 2);
    expect(await agreely.catalog.list()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it.each(["withdrawal_daily_cap", "hold_budget_exhausted", "hold_release_cap_reached"])(
    "never retries the daily cap %s, which keeps its code",
    async (code) => {
      const { agreely, calls } = client([tooMany(code), { json: { catalog: [] } }], 2);
      const err = await agreely.catalog.list().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgreelyDailyCapError);
      expect(err).toMatchObject({ code });
      expect(calls).toHaveLength(1);
    },
  );

  it("never retries verbal_daily_cap, raised as the narrower class", async () => {
    const { agreely, calls } = client([tooMany("verbal_daily_cap", "daily_cap"), { json: { catalog: [] } }], 2);
    const err = await agreely.catalog.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyVerbalDailyCapError);
    expect(calls).toHaveLength(1);
  });

  it("raises any 429 whose reason is daily_cap as a daily cap, whatever its code, and never retries it", async () => {
    const { agreely, calls } = client([tooMany("some_future_cap", "daily_cap"), { json: { catalog: [] } }], 2);
    const err = await agreely.catalog.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyDailyCapError);
    expect(err).toMatchObject({ code: "some_future_cap", reason: "daily_cap" });
    expect(calls).toHaveLength(1);
  });

  it("keeps an unknown 429 code on the base class, never rewritten to rate_limited, and never retries it", async () => {
    const { agreely, calls } = client([tooMany("export_quota"), { json: { catalog: [] } }], 2);
    const err = await agreely.catalog.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyRateLimitError);
    expect(err).not.toBeInstanceOf(AgreelyDailyCapError);
    expect(err).toMatchObject({ code: "export_quota" });
    expect(calls).toHaveLength(1);
  });
});

describe("field and reason on every status", () => {
  it.each([500, 405, 410])("keeps field and reason on a %i", async (status) => {
    const { agreely } = client([
      { status, json: { error: { code: "unavailable", message: "x", field: "f", reason: "r" } } },
      { status, json: { error: { code: "unavailable", message: "x", field: "f", reason: "r" } } },
    ]);
    const err = await agreely.catalog.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyUnavailableError);
    expect(err).toMatchObject({ status, field: "f", reason: "r" });
  });
});

describe("a method that returns a promise rejects, it never throws synchronously", () => {
  const { agreely, calls } = client([{ json: {} }]);
  const invalid: Array<[string, () => Promise<unknown>]> = [
    ["customers.get", () => agreely.customers.get("")],
    ["customers.upsert", () => agreely.customers.upsert("", {})],
    ["withdrawals.record", () => agreely.withdrawals.record("c1", "0xabc", { channel: "phone", operator: "a" })],
    ["retention.placeHold", () => agreely.retention.placeHold("c1", { ground: "lawsuit" } as never)],
    ["retention.releaseHold", () => agreely.retention.releaseHold("c1", "nope", { reason: "r" })],
    ["retention.declareDisposition", () => agreely.retention.declareDisposition("c1", { disposition: "x" } as never)],
    ["retention.declarePurge", () => agreely.retention.declarePurge("r", {} as never, {} as never)],
    ["manualConsents.createConsentSheet", () => agreely.manualConsents.createConsentSheet("", { documentVersionId: "v" })],
    ["manualConsents.record", () => agreely.manualConsents.record({} as never, { idempotencyKey: "bad key" })],
    ["verbalConsents.get", () => agreely.verbalConsents.get("nope")],
    ["relationships.end", () => agreely.relationships.end({ customerRef: "", reason: "r" })],
    ["catalog.forDocument", () => agreely.catalog.forDocument("")],
    ["consentRequests.create", () => agreely.consentRequests.create({} as never)],
    ["inventory.replaceCategories", () => agreely.inventory.replaceCategories({ hostSystem: "crm", categories: [] })],
  ];
  it.each(invalid)("%s", async (_name, call) => {
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = call();
    }).not.toThrow();
    await expect(returned).rejects.toBeInstanceOf(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe("the options of a write are closed", () => {
  const misspelt = { idempotencykey: "my-key" } as never;
  it("refuses a misspelt idempotencyKey instead of silently sending a random key", async () => {
    const { agreely, calls } = client([{ status: 201, json: {} }]);
    const writes: Array<() => Promise<unknown>> = [
      () => agreely.withdrawals.record("c1", REF, { channel: "phone", operator: "agent-1" }, misspelt),
      () => agreely.retention.placeHold("c1", { ground: "rights_request" }, misspelt),
      () => agreely.retention.releaseHold("c1", HOLD, { reason: "r" }, misspelt),
      () =>
        agreely.manualConsents.createConsentSheet(
          "c1",
          { documentVersionId: "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f" },
          misspelt,
        ),
      () =>
        agreely.manualConsents.record(
          {
            customerId: "c1",
            documentVersionId: "d",
            effectiveDate: "2026-06-01",
            validUntil: "2031-01-01",
            items: [],
            evidence: { pdfSha256: "0x" + "f".repeat(64) },
          },
          misspelt,
        ),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toThrow(/unknown option "idempotencykey"/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("customerRef in a path", () => {
  it("refuses . and .., which the URL parser would resolve as a path step", async () => {
    const { agreely, calls } = client([{ status: 201, json: {} }]);
    await expect(agreely.retention.placeHold("..", { ground: "rights_request" })).rejects.toBeInstanceOf(AgreelyConfigError);
    await expect(agreely.customers.get(".")).rejects.toBeInstanceOf(AgreelyConfigError);
    await expect(agreely.relationships.end({ customerRef: " .. ", reason: "r" })).rejects.toBeInstanceOf(
      AgreelyConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("trims exactly what the server trims: ASCII whitespace, never a Unicode space", async () => {
    const { agreely, calls } = client([{ json: {} }, { json: {} }]);
    await agreely.customers.get("\t c1 \n");
    await agreely.customers.get(" c1");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/c1`);
    expect(calls[1]!.url).toBe(`${BASE}/v1/customers/%C2%A0c1`);
  });

  it("encodes a slash and a percent sign so they reach the server as written", async () => {
    const { agreely, calls } = client([{ json: {} }]);
    await agreely.customers.get("STORE/0042%41");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042%2541`);
  });
});

describe("holds feed, fail closed", () => {
  it("reads a missing or unknown status as active", async () => {
    const { agreely } = client([
      {
        json: {
          holds: [
            { id: "1", customerRef: "a", scope: "all", changedAt: "t" },
            { id: "2", customerRef: "b", status: "suspended", scope: "all", changedAt: "t" },
            { id: "3", customerRef: "c", status: "released", scope: "all", changedAt: "t" },
          ],
          nextPageToken: null,
          cursor: "c",
        },
      },
    ]);
    const page = await agreely.retention.listHolds();
    expect(page.holds.map((h) => h.status)).toEqual(["active", "active", "released"]);
  });

  it("holdPages itself throws when maxPages runs out before the last page", async () => {
    const { agreely } = client([{ json: { holds: [], nextPageToken: "more", cursor: null } }]);
    const pages: unknown[] = [];
    const read = async () => {
      for await (const page of agreely.retention.holdPages({ maxPages: 2 })) pages.push(page);
    };
    await expect(read()).rejects.toBeInstanceOf(AgreelyConfigError);
    expect(pages).toHaveLength(2);
  });

  it("an empty changedSince is a snapshot, as the server reads it", async () => {
    const { agreely, calls } = client([{ json: { holds: [], nextPageToken: null, cursor: "c" } }]);
    const sync = await agreely.retention.syncHolds({ changedSince: "" });
    expect(sync.mode).toBe("snapshot");
    expect(new URL(calls[0]!.url).searchParams.has("changedSince")).toBe(false);
  });
});

describe("disposition scheduleRef", () => {
  it("accepts 200 characters and refuses 201, the server's bound", async () => {
    const { agreely, calls } = client([{ status: 201, json: {} }]);
    await agreely.retention.declareDisposition("c1", { disposition: "destroyed", scheduleRef: "r".repeat(200) });
    await expect(
      agreely.retention.declareDisposition("c1", { disposition: "destroyed", scheduleRef: "r".repeat(201) }),
    ).rejects.toBeInstanceOf(AgreelyConfigError);
    expect(calls).toHaveLength(1);
  });

  it("still maps a refusal from the server", async () => {
    const { agreely } = client([{ status: 404, json: { error: { code: "not_found", message: "No customer." } } }]);
    await expect(agreely.retention.declareDisposition("c1", { disposition: "destroyed" })).rejects.toBeInstanceOf(
      AgreelyNotFoundError,
    );
  });
});
