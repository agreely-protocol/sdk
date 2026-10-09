import { describe, expect, it } from "vitest";
import { Agreely, AgreelyAuthError, AgreelyConfigError, AgreelyNotFoundError, AgreelyValidationError } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

const ended = {
  customerRef: "cust-1",
  status: "ended",
  endedAt: "2026-07-02T10:00:00Z",
  endedBy: "company",
};

describe("relationships.end", () => {
  it("posts the reason to the customer-scoped path and returns the ended relationship", async () => {
    const { agreely, calls } = client([{ status: 200, json: ended }]);
    const r = await agreely.relationships.end({ customerRef: "cust-1", reason: "purposes accomplished" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/cust-1/relationship/end`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ reason: "purposes accomplished" });
    expect(r).toEqual(ended);
    expect(r.endedBy).toBe("company");
  });

  it("percent-encodes a ref carrying a slash (never a bare path segment)", async () => {
    const { agreely, calls } = client([{ status: 200, json: { ...ended, customerRef: "STORE/0042" } }]);
    await agreely.relationships.end({ customerRef: "STORE/0042", reason: "done" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042/relationship/end`);
  });

  it("fails CLOSED on a blank reason (AgreelyConfigError) before any wire call", async () => {
    const { agreely, calls } = client([{ status: 200, json: ended }]);
    await expect(agreely.relationships.end({ customerRef: "cust-1", reason: "   " })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("fails CLOSED on a missing customerRef before any wire call", async () => {
    const { agreely, calls } = client([{ status: 200, json: ended }]);
    await expect(agreely.relationships.end({ customerRef: "  ", reason: "done" })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a 403 (missing 'relationship' scope) as AgreelyAuthError", async () => {
    const { agreely } = client([
      { status: 403, json: { error: { code: "forbidden", message: "This API key does not carry the 'relationship' scope." } } },
    ]);
    await expect(agreely.relationships.end({ customerRef: "cust-1", reason: "done" })).rejects.toBeInstanceOf(
      AgreelyAuthError,
    );
  });

  it("surfaces a server 422 as AgreelyValidationError", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "invalid_request", message: "reason is required.", field: "reason" } } },
    ]);
    await expect(
      agreely.relationships.end({ customerRef: "cust-1", reason: "x" }),
    ).rejects.toBeInstanceOf(AgreelyValidationError);
  });

  it("maps an unknown/foreign ref (404) to AgreelyNotFoundError", async () => {
    const { agreely } = client([{ status: 404, json: { error: { code: "not_found", message: "No customer with that reference." } } }]);
    await expect(agreely.relationships.end({ customerRef: "ghost", reason: "done" })).rejects.toBeInstanceOf(
      AgreelyNotFoundError,
    );
  });

  it("does NOT retry on a 503 (the end mutates)", async () => {
    const { agreely, calls } = client([{ status: 503 }, { status: 200, json: ended }]);
    await expect(agreely.relationships.end({ customerRef: "cust-1", reason: "done" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

const reverted = {
  customerRef: "cust-1",
  status: "active",
  reverted: true,
};

describe("relationships.revert", () => {
  it("posts the reason to the revert path and returns the active relationship", async () => {
    const { agreely, calls } = client([{ status: 200, json: reverted }]);
    const r = await agreely.relationships.revert({ customerRef: "cust-1", reason: "ended by mistake" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/cust-1/relationship/revert`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ reason: "ended by mistake" });
    expect(r).toEqual(reverted);
    expect(r.reverted).toBe(true);
  });

  it("percent-encodes a ref carrying a slash", async () => {
    const { agreely, calls } = client([{ status: 200, json: { ...reverted, customerRef: "STORE/0042" } }]);
    await agreely.relationships.revert({ customerRef: "STORE/0042", reason: "mistake" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042/relationship/revert`);
  });

  it("fails CLOSED on a blank reason (AgreelyConfigError) before any wire call", async () => {
    const { agreely, calls } = client([{ status: 200, json: reverted }]);
    await expect(agreely.relationships.revert({ customerRef: "cust-1", reason: "   " })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("fails CLOSED on a missing customerRef before any wire call", async () => {
    const { agreely, calls } = client([{ status: 200, json: reverted }]);
    await expect(agreely.relationships.revert({ customerRef: "  ", reason: "mistake" })).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("maps a non-eligible/foreign ref (404) to AgreelyNotFoundError", async () => {
    const { agreely } = client([
      { status: 404, json: { error: { code: "not_found", message: "This end is not undo-eligible." } } },
    ]);
    await expect(agreely.relationships.revert({ customerRef: "ghost", reason: "mistake" })).rejects.toBeInstanceOf(
      AgreelyNotFoundError,
    );
  });

  it("does NOT retry on a 503 (the revert mutates)", async () => {
    const { agreely, calls } = client([{ status: 503 }, { status: 200, json: reverted }]);
    await expect(agreely.relationships.revert({ customerRef: "cust-1", reason: "mistake" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
