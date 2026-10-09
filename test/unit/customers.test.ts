import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyNotFoundError,
  AgreelyValidationError,
  type CustomerRecord,
} from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

const record: CustomerRecord = {
  customerRef: "STORE/0042",
  registered: true,
  source: "api",
  hasDisplayName: true,
  hasEmail: false,
  hasBasisNote: false,
  legalBasis: "contract",
  noticeLocale: "fr",
  createdAt: "2026-10-08T20:13:48Z",
  updatedAt: "2026-10-08T20:13:48Z",
  relationship: { status: "active", endedAt: null },
};

describe("customers.get", () => {
  it("reads one customer's metadata by its encoded ref", async () => {
    const { agreely, calls } = client([{ json: record }]);
    expect(await agreely.customers.get(" STORE/0042 ")).toEqual(record);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042`);
  });

  it("an untouched or foreign ref is AgreelyNotFoundError; a blank or over-long one is refused locally", async () => {
    const { agreely, calls } = client([{ status: 404, json: { error: { code: "not_found", message: "No customer." } } }]);
    await expect(agreely.customers.get("")).rejects.toThrow(AgreelyConfigError);
    await expect(agreely.customers.get("x".repeat(201))).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
    await expect(agreely.customers.get("ghost")).rejects.toBeInstanceOf(AgreelyNotFoundError);
  });
});

describe("customers.upsert (a merge, never a replace)", () => {
  it("sends only the members given: absent is untouched, null and empty clear, a value writes", async () => {
    const { agreely, calls } = client([{ status: 200, json: record }]);
    await agreely.customers.upsert("STORE/0042", { displayName: "Marie", email: null, basisNote: "" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042`);
    expect(calls[0]!.body).toEqual({ displayName: "Marie", email: null, basisNote: "" });
  });

  it("drops members set to undefined and anything that is not a registry member", async () => {
    const { agreely, calls } = client([{ status: 200, json: record }]);
    await agreely.customers.upsert("c1", { legalBasis: "contract", noticeLocale: undefined, company: "x" } as never);
    expect(calls[0]!.body).toEqual({ legalBasis: "contract" });
  });

  it("reports created from the status: 201 created, 200 merged", async () => {
    const { agreely } = client([
      { status: 201, json: record },
      { status: 200, json: record },
    ]);
    expect((await agreely.customers.upsert("c1", { email: "a@example.com" })).created).toBe(true);
    const merged = await agreely.customers.upsert("c1", { email: "a@example.com" });
    expect(merged.created).toBe(false);
    expect(merged.hasDisplayName).toBe(true);
  });

  it("refuses a non-string member before any call (never coerced into the register)", async () => {
    const { agreely, calls } = client([{ status: 200, json: record }]);
    await expect(agreely.customers.upsert("c1", { displayName: 42 as unknown as string })).rejects.toBeInstanceOf(
      AgreelyConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("a closed identity is a 409 whose stable string travels in code", async () => {
    const { agreely } = client([
      { status: 409, json: { error: { code: "identity_held", message: "A hold keeps it." } } },
      { status: 409, json: { error: { code: "identity_erased", message: "Removed." } } },
    ]);
    const held = await agreely.customers.upsert("c1", { email: null }).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(AgreelyConflictError);
    expect(held).toMatchObject({ code: "identity_held", reason: undefined });
    await expect(agreely.customers.upsert("c1", { displayName: "Marie" })).rejects.toMatchObject({
      code: "identity_erased",
    });
  });

  it("a ground outside the tenant's act is a 422 naming legalBasis, never dropped silently", async () => {
    const { agreely } = client([
      {
        status: 422,
        json: { error: { code: "invalid_request", message: "Not a ground of P-39.1.", field: "legalBasis" } },
      },
    ]);
    await expect(agreely.customers.upsert("c1", { legalBasis: "attributions" })).rejects.toSatisfy(
      (e: unknown) => e instanceof AgreelyValidationError && e.field === "legalBasis",
    );
  });

  it("is never auto-retried", async () => {
    const { agreely, calls } = client([{ status: 503 }, { status: 200, json: record }]);
    await expect(agreely.customers.upsert("c1", { email: null })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
