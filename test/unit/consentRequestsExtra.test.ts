import { describe, expect, it } from "vitest";
import { Agreely, AgreelyAbortError, AgreelyRateLimitError, AgreelyTimeoutError } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

function client(fetchImpl: typeof globalThis.fetch, extra: Record<string, unknown> = {}): Agreely {
  return new Agreely({ apiKey: "agr_live_test", timeout: 5000, fetch: fetchImpl, ...extra });
}

const rec = (id: string, status = "pending", extra: Record<string, unknown> = {}) => ({
  requestId: id,
  status,
  validUntil: "2031-01-01T00:00:00Z",
  expiresAt: "2031-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  settledAt: null,
  customerId: "cust_1",
  documentCode: "conditions-marketing",
  items: [],
  document: null,
  ...extra,
});

describe("consentRequests.listAll / collect", () => {
  it("loops nextCursor to exhaustion and stops on null", async () => {
    const { fetch, calls } = mockFetch([
      { json: { requests: [rec("0xa"), rec("0xb")], nextCursor: "0xb" } },
      { json: { requests: [rec("0xc")], nextCursor: null } },
    ]);
    const all = await client(fetch).consentRequests.collect();
    expect(all.map((r) => r.requestId)).toEqual(["0xa", "0xb", "0xc"]);
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toContain("cursor=0xb");
  });

  it("honors the maxPages guard", async () => {
    const { fetch, calls } = mockFetch([
      // Always returns a next cursor — the guard must stop it.
      () => ({ json: { requests: [rec("0xloop")], nextCursor: "0xnext" } }),
    ]);
    const all = await client(fetch).consentRequests.collect({ maxPages: 3 });
    expect(all.length).toBe(3);
    expect(calls.length).toBe(3);
  });

  it("treats a non-positive maxPages as the default bound (not a silent no-op)", async () => {
    const { fetch, calls } = mockFetch([
      { json: { requests: [rec("0xa")], nextCursor: "0xa" } },
      { json: { requests: [rec("0xb")], nextCursor: null } },
    ]);
    // A computed 0 must fall back to the default bound and still iterate, not stop.
    const all = await client(fetch).consentRequests.collect({ maxPages: 0 });
    expect(all.map((r) => r.requestId)).toEqual(["0xa", "0xb"]);
    expect(calls.length).toBe(2);
  });

  it("coerces an absent wire nextCursor to null so listAll stops (TS<->PHP parity)", async () => {
    const { fetch, calls } = mockFetch([
      // The wire omits nextCursor entirely — listAll must still terminate.
      { json: { requests: [rec("0xa")] } },
    ]);
    const all = await client(fetch).consentRequests.collect();
    expect(all.map((r) => r.requestId)).toEqual(["0xa"]);
    expect(calls.length).toBe(1);
  });
});

describe("consentRequests.list filters (customerId + status + limit + cursor)", () => {
  it("puts customerId, status, limit and cursor on the query string", async () => {
    const { fetch, calls } = mockFetch([{ json: { requests: [rec("0xa")], nextCursor: null } }]);
    const page = await client(fetch).consentRequests.list({
      customerId: "cust_42",
      status: "pending",
      limit: 25,
      cursor: "0xprev",
    });
    expect(page.items.map((r) => r.requestId)).toEqual(["0xa"]);
    const url = calls[0]!.url;
    expect(url).toContain("customerId=cust_42");
    expect(url).toContain("status=pending");
    expect(url).toContain("limit=25");
    expect(url).toContain("cursor=0xprev");
  });

  it("surfaces the new customerId + documentCode fields on a record", async () => {
    const { fetch } = mockFetch([
      { json: { requests: [rec("0xa", "pending", { customerId: "cust_9", documentCode: "infolettre" })], nextCursor: null } },
    ]);
    const page = await client(fetch).consentRequests.list();
    expect(page.items[0]).toMatchObject({ customerId: "cust_9", documentCode: "infolettre" });
  });

  it("omits absent filters from the query string", async () => {
    const { fetch, calls } = mockFetch([{ json: { requests: [], nextCursor: null } }]);
    await client(fetch).consentRequests.list();
    const url = calls[0]!.url;
    expect(url).not.toContain("customerId=");
    expect(url).not.toContain("status=");
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("cursor=");
  });
});

describe("consentRequests.hasPending (the dedup helper)", () => {
  it("returns true when a pending request exists for the customer", async () => {
    const { fetch, calls } = mockFetch([
      { json: { requests: [rec("0xa", "pending", { customerId: "cust_1" })], nextCursor: null } },
    ]);
    const has = await client(fetch).consentRequests.hasPending("cust_1");
    expect(has).toBe(true);
    // It queries status:pending scoped to the customer.
    const url = calls[0]!.url;
    expect(url).toContain("customerId=cust_1");
    expect(url).toContain("status=pending");
  });

  it("returns false when no pending request exists", async () => {
    const { fetch } = mockFetch([{ json: { requests: [], nextCursor: null } }]);
    expect(await client(fetch).consentRequests.hasPending("cust_1")).toBe(false);
  });

  it("narrows to a documentCode when one is supplied", async () => {
    const { fetch } = mockFetch([
      {
        json: {
          requests: [
            rec("0xa", "pending", { documentCode: "conditions-marketing" }),
            rec("0xb", "pending", { documentCode: "infolettre" }),
          ],
          nextCursor: null,
        },
      },
    ]);
    expect(await client(fetch).consentRequests.hasPending("cust_1", "infolettre")).toBe(true);
  });

  it("returns false when a pending request exists but under a different documentCode", async () => {
    const { fetch } = mockFetch([
      { json: { requests: [rec("0xa", "pending", { documentCode: "conditions-marketing" })], nextCursor: null } },
    ]);
    expect(await client(fetch).consentRequests.hasPending("cust_1", "infolettre")).toBe(false);
  });

  it("paginates while searching (finds a match on a later page)", async () => {
    const { fetch, calls } = mockFetch([
      { json: { requests: [rec("0xa", "pending", { documentCode: "other" })], nextCursor: "0xa" } },
      { json: { requests: [rec("0xb", "pending", { documentCode: "infolettre" })], nextCursor: null } },
    ]);
    expect(await client(fetch).consentRequests.hasPending("cust_1", "infolettre")).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toContain("cursor=0xa");
  });

  it("throws AgreelyConfigError on a blank customerId (before any wire call)", async () => {
    const { fetch, calls } = mockFetch([{ json: { requests: [], nextCursor: null } }]);
    await expect(client(fetch).consentRequests.hasPending("  ")).rejects.toMatchObject({
      name: "AgreelyConfigError",
    });
    expect(calls.length).toBe(0);
  });
});

describe("consentRequests.waitForSettlement", () => {
  it("resolves when the request reaches a terminal state", async () => {
    const { fetch } = mockFetch([
      { json: rec("0xr", "pending") },
      { json: rec("0xr", "approved") },
    ]);
    const settled = await client(fetch).consentRequests.waitForSettlement("0xr", {
      intervalMs: 1,
      timeoutMs: 1000,
    });
    expect(settled.status).toBe("approved");
  });

  it("throws AgreelyTimeoutError with the last status when the budget elapses", async () => {
    const { fetch } = mockFetch([() => ({ json: rec("0xr", "pending") })]);
    await expect(
      client(fetch).consentRequests.waitForSettlement("0xr", { intervalMs: 5, timeoutMs: 12 }),
    ).rejects.toMatchObject({ name: "AgreelyTimeoutError", lastStatus: "pending" });
  });

  it("throws AgreelyAbortError (NOT a timeout) on an already-aborted signal", async () => {
    const { fetch } = mockFetch([() => ({ json: rec("0xr", "pending") })]);
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await client(fetch)
      .consentRequests.waitForSettlement("0xr", { signal: ctrl.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyAbortError);
    expect(err).not.toBeInstanceOf(AgreelyTimeoutError);
  });

  it("honors an abort PROMPTLY mid-sleep, not up to intervalMs later", async () => {
    // A long interval: without prompt abort this would hang ~10s. The abort fires
    // during the inter-poll sleep and must reject almost immediately.
    const { fetch } = mockFetch([() => ({ json: rec("0xr", "pending") })]);
    const ctrl = new AbortController();
    const started = Date.now();
    const pending = client(fetch)
      .consentRequests.waitForSettlement("0xr", { intervalMs: 10_000, timeoutMs: 60_000, signal: ctrl.signal })
      .catch((e: unknown) => e);
    setTimeout(() => ctrl.abort(), 20);
    const err = await pending;
    expect(err).toBeInstanceOf(AgreelyAbortError);
    expect((err as AgreelyAbortError).lastStatus).toBe("pending");
    expect(Date.now() - started).toBeLessThan(2000); // woke promptly, not after 10s
  });
});

describe("rate-limit surfacing", () => {
  it("exposes retryAfter and retryAfterSeconds from the Retry-After header", async () => {
    const { fetch } = mockFetch([
      { status: 429, json: { error: { code: "rate_limited", message: "slow down" } }, headers: { "Retry-After": "7" } },
    ]);
    try {
      await client(fetch).consentRequests.get("0xr");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgreelyRateLimitError);
      const err = e as AgreelyRateLimitError;
      expect(err.retryAfter).toBe(7);
      expect(err.retryAfterSeconds).toBe(7);
    }
  });

  it("opt-in maxRetries retries an idempotent GET after a 429 then succeeds", async () => {
    const { fetch, calls } = mockFetch([
      { status: 429, json: { error: { code: "rate_limited", message: "slow" } }, headers: { "Retry-After": "0" } },
      { json: rec("0xr", "approved") },
    ]);
    const settled = await client(fetch, { maxRetries: 2 }).consentRequests.get("0xr");
    expect(settled.status).toBe("approved");
    expect(calls.length).toBe(2);
  });
});
