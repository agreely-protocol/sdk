import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  const agreely = new Agreely({ apiKey: "agr_live_test", baseUrl: BASE, fetch });
  return { agreely, calls };
}

const allow = { decision: "allow", status: "active", consentRef: "0xabc", checkedAt: "2026-01-01T00:00:00Z" };
const deny = { decision: "deny", status: "none", checkedAt: "2026-01-01T00:00:00Z" };

describe("checkBatch()", () => {
  it("POSTs to /v1/check/batch with the items array and returns decisions", async () => {
    const { agreely, calls } = client([
      { json: { decisions: [allow, deny] } },
    ]);
    const items = [
      { customerRef: "c1", category: "Email", purpose: "Marketing" },
      { customerRef: "c2", category: "Phone", purpose: "Billing" },
    ];
    const decisions = await agreely.checkBatch(items);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.decision).toBe("allow");
    expect(decisions[1]!.decision).toBe("deny");
    expect(calls[0]!.url).toBe(`${BASE}/v1/check/batch`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ items });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer agr_live_test");
  });

  it("sends category/purpose RAW, no client-side normalization", async () => {
    const { agreely, calls } = client([
      { json: { decisions: [deny] } },
    ]);
    await agreely.checkBatch([
      { customerRef: "c1", category: "  Email   ADDRESS ", purpose: "Marketing\tOutreach" },
    ]);
    const body = calls[0]!.body as { items: Array<{ category: string; purpose: string }> };
    expect(body.items[0]!.category).toBe("  Email   ADDRESS ");
    expect(body.items[0]!.purpose).toBe("Marketing\tOutreach");
  });

  it("short-circuits to an empty array without a network call for an empty input", async () => {
    const { agreely, calls } = client([]);
    expect(await agreely.checkBatch([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("aligns decisions to items: allow has consentRef, deny/none does not", async () => {
    const { agreely } = client([
      { json: { decisions: [allow, { decision: "deny", status: "none", checkedAt: "t" }] } },
    ]);
    const [a, b] = await agreely.checkBatch([
      { customerRef: "c1", category: "Email", purpose: "Marketing" },
      { customerRef: "c2", category: "Phone", purpose: "Billing" },
    ]);
    expect(a!.consentRef).toBe("0xabc");
    expect(b!.consentRef).toBeUndefined();
  });
});

describe("checkFields()", () => {
  it("builds the cartesian product and calls checkBatch once", async () => {
    const { agreely, calls } = client([
      {
        json: {
          decisions: [
            { customerRef: "c1", category: "Email", purpose: "Marketing", decision: "allow", status: "active", checkedAt: "t" },
            { customerRef: "c1", category: "Phone", purpose: "Billing", decision: "deny", status: "none", checkedAt: "t" },
            { customerRef: "c2", category: "Email", purpose: "Marketing", decision: "deny", status: "none", checkedAt: "t" },
            { customerRef: "c2", category: "Phone", purpose: "Billing", decision: "allow", status: "active", checkedAt: "t" },
          ],
        },
      },
    ]);
    const result = await agreely.checkFields(["c1", "c2"], [
      { category: "Email", purpose: "Marketing" },
      { category: "Phone", purpose: "Billing" },
    ]);
    expect(calls).toHaveLength(1);
    expect(result.decisions).toHaveLength(4);
    expect(result.isAllowed("c1", "Email", "Marketing")).toBe(true);
    expect(result.isAllowed("c1", "Phone", "Billing")).toBe(false);
    expect(result.isAllowed("c2", "Email", "Marketing")).toBe(false);
    expect(result.isAllowed("c2", "Phone", "Billing")).toBe(true);
  });

  it("isAllowed returns false for a triple not in the result set", async () => {
    const { agreely } = client([
      { json: { decisions: [{ customerRef: "c1", category: "Email", purpose: "Marketing", decision: "allow", status: "active", checkedAt: "t" }] } },
    ]);
    const result = await agreely.checkFields(["c1"], [{ category: "Email", purpose: "Marketing" }]);
    expect(result.isAllowed("unknown", "Email", "Marketing")).toBe(false);
    expect(result.isAllowed("c1", "Email", "Other")).toBe(false);
  });

  it("preserves raw strings in the lookup (case and whitespace sensitive)", async () => {
    const { agreely } = client([
      {
        json: {
          decisions: [
            { customerRef: "c1", category: "  Email  ", purpose: "Marketing", decision: "allow", status: "active", checkedAt: "t" },
          ],
        },
      },
    ]);
    const result = await agreely.checkFields(["c1"], [{ category: "  Email  ", purpose: "Marketing" }]);
    expect(result.isAllowed("c1", "  Email  ", "Marketing")).toBe(true);
    expect(result.isAllowed("c1", "Email", "Marketing")).toBe(false);
  });
});
