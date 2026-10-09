import { describe, expect, it } from "vitest";
import { Agreely, AgreelyAuthError, AgreelyConfigError, AgreelyNotFoundError } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const REQ_ID = "0x" + "a".repeat(64);

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

describe("consentRequests.create, Idempotency-Key", () => {
  const input = {
    customerId: "c1",
    recipientEmail: "user@example.com",
    consentDocumentId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    validUntil: "2031-01-01",
  };
  const created = {
    requestId: REQ_ID, status: "pending", deepLink: "https://x", emailDelivered: true,
    items: [{ category: "Email", purpose: "News" }],
    document: { code: "terms", name: "Terms", version: "1.0" },
  };

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

  it("sends the bound consent document id and NEVER an items list", async () => {
    const { agreely, calls } = client([{ status: 201, json: created }]);
    await agreely.consentRequests.create(input);
    expect(calls[0]!.body).toMatchObject({
      customerId: "c1",
      recipientEmail: "user@example.com",
      validUntil: "2031-01-01",
      consentDocumentId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    });
    expect(calls[0]!.body).not.toHaveProperty("items");
  });

  it("sends documentCode when given instead of the id", async () => {
    const { agreely, calls } = client([{ status: 201, json: created }]);
    await agreely.consentRequests.create({
      customerId: "c1", recipientEmail: "user@example.com", documentCode: "terms", validUntil: "2031-01-01",
    });
    expect(calls[0]!.body).toMatchObject({ documentCode: "terms" });
    expect(calls[0]!.body).not.toHaveProperty("consentDocumentId");
  });

  it("throws AgreelyConfigError without a consent document reference (nothing sent)", async () => {
    const { agreely, calls } = client([]);
    expect(() =>
      agreely.consentRequests.create({ customerId: "c1", recipientEmail: "u@x.com", validUntil: "2031-01-01" }),
    ).toThrow(AgreelyConfigError);
    expect(calls.length).toBe(0);
  });

  it("throws AgreelyConfigError when BOTH consentDocumentId and documentCode are given", async () => {
    const { agreely, calls } = client([]);
    expect(() =>
      agreely.consentRequests.create({
        customerId: "c1", recipientEmail: "u@x.com", validUntil: "2031-01-01",
        consentDocumentId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", documentCode: "terms",
      }),
    ).toThrow(AgreelyConfigError);
    expect(calls.length).toBe(0);
  });

  it("returns the issued request keyed on the protocol requestId, with its document", async () => {
    const { agreely } = client([{ status: 201, json: created }]);
    const r = await agreely.consentRequests.create(input);
    expect(r.requestId).toBe(REQ_ID);
    expect(r.status).toBe("pending");
    expect(r.document).toEqual({ code: "terms", name: "Terms", version: "1.0" });
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

describe("client.identity", () => {
  it("GETs /v1/whoami and returns the server-verified scopes", async () => {
    const { agreely, calls } = client([{ json: { scopes: ["check", "issue"] } }]);
    const identity = await agreely.identity();
    expect(identity.scopes).toEqual(["check", "issue"]);
    expect(calls[0]!.url).toBe(`${BASE}/v1/whoami`);
    expect(calls[0]!.method).toBe("GET");
  });

  it("surfaces a 401 as AgreelyAuthError", async () => {
    const { agreely } = client([
      { status: 401, json: { error: { code: "unauthorized", message: "no" } } },
    ]);
    await expect(agreely.identity()).rejects.toBeInstanceOf(AgreelyAuthError);
  });

  it("exposes the configured baseUrl client-side", () => {
    const { agreely } = client([]);
    expect(agreely.baseUrl).toBe(BASE);
  });
});

describe("consentRequests.cancel", () => {
  it("POSTs to /{id}/cancel and returns the cancel outcome (cancelled:true)", async () => {
    const out = { requestId: REQ_ID, status: "revoked_before_action", cancelled: true };
    const { agreely, calls } = client([{ json: out }]);
    const r = await agreely.consentRequests.cancel(REQ_ID);
    expect(r).toEqual(out);
    expect(calls[0]!.url).toBe(`${BASE}/v1/consent-requests/${REQ_ID}/cancel`);
    expect(calls[0]!.method).toBe("POST");
  });

  it("returns cancelled:false idempotently for an already-terminal request", async () => {
    const out = { requestId: REQ_ID, status: "approved", cancelled: false };
    const { agreely } = client([{ json: out }]);
    const r = await agreely.consentRequests.cancel(REQ_ID);
    expect(r.cancelled).toBe(false);
    expect(r.status).toBe("approved");
  });

  it("maps a 404 to AgreelyNotFoundError", async () => {
    const { agreely } = client([
      { status: 404, json: { error: { code: "not_found", message: "no such request" } } },
    ]);
    await expect(agreely.consentRequests.cancel(REQ_ID)).rejects.toBeInstanceOf(
      AgreelyNotFoundError,
    );
  });
});

describe("catalog.list", () => {
  it("unwraps the {catalog} envelope to an array", async () => {
    const entry = { id: "uuid-1", category: "Email", purpose: "News", description: null };
    const { agreely } = client([{ json: { catalog: [entry] } }]);
    expect(await agreely.catalog.list()).toEqual([entry]);
  });
});

describe("catalog.forDocument", () => {
  const scoped = {
    regime: { sector: "public", statute: "A-2.1" },
    document: { code: "inscription-repas", documentVersionId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" },
    catalog: [
      {
        id: "uuid-1",
        category: "Coordonnées",
        purpose: "Livraison des repas",
        description: null,
        legalBasis: "attributions",
        sensitive: false,
      },
    ],
  };

  it("sends GET /v1/catalog with the documentCode filter, trimmed and encoded, and returns the whole body", async () => {
    const { agreely, calls } = client([{ json: scoped }]);
    const r = await agreely.catalog.forDocument(" inscription repas ");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/v1/catalog`);
    expect([...url.searchParams.entries()]).toEqual([["documentCode", "inscription repas"]]);
    expect(calls[0]!.url).toBe(`${BASE}/v1/catalog?documentCode=inscription+repas`);
    expect(r).toEqual(scoped);
    expect(r.document.documentVersionId).toBe("6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  });

  it("refuses a blank code before any call, and maps an unknown or foreign code to AgreelyNotFoundError", async () => {
    const { agreely, calls } = client([
      {
        status: 404,
        json: { error: { code: "not_found", message: "No published consent document matches that code.", field: "documentCode" } },
      },
    ]);
    expect(() => agreely.catalog.forDocument("  ")).toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
    await expect(agreely.catalog.forDocument("other-tenant")).rejects.toMatchObject({
      name: "AgreelyNotFoundError",
      field: "documentCode",
    });
  });
});
