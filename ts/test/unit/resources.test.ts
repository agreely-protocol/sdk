import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const REQ_ID = "0x" + "a".repeat(64);

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

describe("consentRequests.create — Idempotency-Key", () => {
  const input = {
    customerId: "c1",
    recipientEmail: "user@example.com",
    items: ["cat-id-1", { category: "Email", purpose: "News" }],
    validUntil: "2031-01-01",
  };
  const created = { requestId: REQ_ID, status: "pending", deepLink: "https://x", emailDelivered: true, items: [{ category: "Email", purpose: "News" }] };

  it("auto-generates a unique Idempotency-Key per call", async () => {
    const { agreely, calls } = client([{ status: 201, json: created }, { status: 201, json: created }]);
    await agreely.consentRequests.create(input);
    await agreely.consentRequests.create(input);
    const k1 = calls[0]!.headers["Idempotency-Key"];
    const k2 = calls[1]!.headers["Idempotency-Key"];
    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();
    expect(k1).not.toBe(k2);
  });

  it("honors an overridden Idempotency-Key (so a retry replays, not double-issues)", async () => {
    const { agreely, calls } = client([{ status: 201, json: created }]);
    await agreely.consentRequests.create(input, { idempotencyKey: "my-key-123" });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("my-key-123");
  });

  it("sends items RAW (strings and {category,purpose} pairs untouched)", async () => {
    const { agreely, calls } = client([{ status: 201, json: created }]);
    await agreely.consentRequests.create(input);
    expect(calls[0]!.body).toMatchObject({
      customerId: "c1",
      recipientEmail: "user@example.com",
      validUntil: "2031-01-01",
      items: ["cat-id-1", { category: "Email", purpose: "News" }],
    });
  });

  it("returns the issued request keyed on the protocol requestId", async () => {
    const { agreely } = client([{ status: 201, json: created }]);
    const r = await agreely.consentRequests.create(input);
    expect(r.requestId).toBe(REQ_ID);
    expect(r.status).toBe("pending");
  });
});

describe("consentRequests.list", () => {
  it("maps the wire `requests` field to `items` and passes the cursor through", async () => {
    const record = { requestId: REQ_ID, status: "pending", validUntil: "t", expiresAt: "t", createdAt: "t", settledAt: null, items: [] };
    const { agreely, calls } = client([{ json: { requests: [record], nextCursor: "0xbeef" } }]);
    const page = await agreely.consentRequests.list({ status: "pending", cursor: "0xprev" });
    expect(page.items).toEqual([record]);
    expect(page.nextCursor).toBe("0xbeef");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("cursor")).toBe("0xprev");
  });

  it("omits empty query params", async () => {
    const { agreely, calls } = client([{ json: { requests: [], nextCursor: null } }]);
    await agreely.consentRequests.list();
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
  });
});

describe("consentRequests.get", () => {
  it("fetches by protocol requestId", async () => {
    const record = { requestId: REQ_ID, status: "approved", validUntil: "t", expiresAt: "t", createdAt: "t", settledAt: "t", items: [] };
    const { agreely, calls } = client([{ json: record }]);
    const r = await agreely.consentRequests.get(REQ_ID);
    expect(r.requestId).toBe(REQ_ID);
    expect(calls[0]!.url).toBe(`${BASE}/v1/consent-requests/${REQ_ID}`);
  });
});

describe("catalog.list", () => {
  it("unwraps the {catalog} envelope to an array", async () => {
    const entry = { id: "uuid-1", category: "Email", purpose: "News", description: null };
    const { agreely } = client([{ json: { catalog: [entry] } }]);
    expect(await agreely.catalog.list()).toEqual([entry]);
  });
});
