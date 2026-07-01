import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { mockFetch, networkError } from "./helpers.js";

const BASE = "http://api.test";

describe("retry policy", () => {
  it("retries check on a 503 then succeeds (idempotent read)", async () => {
    const { fetch, calls } = mockFetch([
      { status: 503, json: { error: { code: "unavailable", message: "down" } } },
      { json: { decision: "allow", status: "active", consentRef: "0x1", checkedAt: "t" } },
    ]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    expect(await agreely.check("c", "cat", "pur")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries check on a network error then succeeds", async () => {
    const { fetch, calls } = mockFetch([
      { throw: networkError() },
      { json: { decision: "deny", status: "none", checkedAt: "t" } },
    ]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    expect(await agreely.check("c", "cat", "pur")).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("caps check retries at 2 attempts", async () => {
    const { fetch, calls } = mockFetch([
      { status: 503, json: { error: { code: "unavailable", message: "down" } } },
      { status: 503, json: { error: { code: "unavailable", message: "down" } } },
      { json: { decision: "allow", status: "active", checkedAt: "t" } },
    ]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    // Two 503s exhaust the budget -> fail closed -> false. Only 2 calls made.
    expect(await agreely.check("c", "cat", "pur")).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry consentRequests.create on a 503 (never auto-retry an issuance)", async () => {
    const { fetch, calls } = mockFetch([
      { status: 503, json: { error: { code: "unavailable", message: "down" } } },
      { status: 201, json: { requestId: "0x" + "a".repeat(64), status: "pending", deepLink: "x", emailDelivered: true, items: [] } },
    ]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    await expect(
      agreely.consentRequests.create({
        customerId: "c",
        recipientEmail: "a@b.co",
        consentDocumentId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
        validUntil: "2030-01-01",
      }),
    ).rejects.toMatchObject({ name: "AgreelyUnavailableError" });
    expect(calls).toHaveLength(1); // exactly one attempt — no double-issue
  });

  it("does NOT retry a non-idempotent 400 on list", async () => {
    const { fetch, calls } = mockFetch([
      { status: 400, json: { error: { code: "invalid_request", message: "bad" } } },
    ]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    await expect(agreely.consentRequests.list()).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});
