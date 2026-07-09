import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  const agreely = new Agreely({ apiKey: "agr_live_test", baseUrl: BASE, fetch });
  return { agreely, calls };
}

describe("check() boolean mapping", () => {
  it("maps a 200 allow to true", async () => {
    const { agreely } = client([
      { json: { decision: "allow", status: "active", consentRef: "0xabc", checkedAt: "2026-01-01T00:00:00Z" } },
    ]);
    expect(await agreely.check("c1", "Phone number", "Billing")).toBe(true);
  });

  it("maps a 200 deny (status none) to false", async () => {
    const { agreely } = client([{ json: { decision: "deny", status: "none", checkedAt: "t" } }]);
    expect(await agreely.check("c1", "Phone", "Billing")).toBe(false);
  });

  it.each(["revoked", "expired", "erased"])("maps a 200 deny (status %s) to false", async (status) => {
    const { agreely } = client([
      { json: { decision: "deny", status, consentRef: "0xabc", checkedAt: "t" } },
    ]);
    expect(await agreely.check("c1", "Phone", "Billing")).toBe(false);
  });

  it("fail-closes to false on a 402 (company subscription lapsed), never an allow", async () => {
    const { agreely } = client([
      { status: 402, json: { error: { code: "billing_inactive", message: "subscription lapsed" } } },
    ]);
    expect(await agreely.check("c1", "Phone", "Billing")).toBe(false);
  });

  it("sends category/purpose RAW — no client-side normalization", async () => {
    const { agreely, calls } = client([{ json: { decision: "deny", status: "none", checkedAt: "t" } }]);
    await agreely.check("c1", "  Email   ADDRESS ", "Marketing\tOutreach");
    expect(calls[0]!.body).toEqual({
      customerId: "c1",
      category: "  Email   ADDRESS ",
      purpose: "Marketing\tOutreach",
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/check`);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer agr_live_test");
  });
});

describe("checkDetailed() shapes", () => {
  it("returns the full decision object on allow", async () => {
    const { agreely } = client([
      { json: { decision: "allow", status: "active", consentRef: "0xdead", checkedAt: "2026-01-01T00:00:00Z" } },
    ]);
    const r = await agreely.checkDetailed("c1", "Phone", "Billing");
    expect(r).toEqual({
      decision: "allow",
      status: "active",
      consentRef: "0xdead",
      checkedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("returns a deny object (consentRef absent for status none) without throwing", async () => {
    const { agreely } = client([{ json: { decision: "deny", status: "none", checkedAt: "t" } }]);
    const r = await agreely.checkDetailed("c1", "Phone", "Billing");
    expect(r.decision).toBe("deny");
    expect(r.status).toBe("none");
    expect(r.consentRef).toBeUndefined();
  });
});

describe("no allow-cache", () => {
  it("makes a fresh network call on every check (a revoke between calls flips instantly)", async () => {
    const { agreely, calls } = client([
      { json: { decision: "allow", status: "active", consentRef: "0x1", checkedAt: "t" } },
      { json: { decision: "deny", status: "revoked", consentRef: "0x1", checkedAt: "t" } },
    ]);
    expect(await agreely.check("c1", "Email", "News")).toBe(true);
    expect(await agreely.check("c1", "Email", "News")).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
