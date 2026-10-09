import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyAuthError,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyValidationError,
  type CustomerRetention,
  type DeclaredDisposition,
  type PlacedHold,
  type ReleasedHold,
  type RetentionHoldFeedItem,
} from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const HOLD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const RULE = "0b7f3c1e-2d4a-4f5b-9c6d-7e8f9a0b1c2d";

function client(script: Parameters<typeof mockFetch>[0], maxRetries?: number) {
  const { fetch, calls } = mockFetch(script);
  return {
    agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch, ...(maxRetries ? { maxRetries } : {}) }),
    calls,
  };
}

const hold = {
  id: HOLD,
  status: "active",
  scope: "all",
  placedBy: "api",
  startedOn: "2026-10-08",
  placedAt: "2026-10-08T18:00:00Z",
  releasedAt: null,
  ground: "other_law",
  hasProvision: true,
  reviewOn: null,
  hasReleaseReason: false,
} as const;

describe("retention.getCustomerRetention", () => {
  it("reads the derived clock, the standing disposition and the holds", async () => {
    const body: CustomerRetention = {
      customerRef: "c1",
      relationship: { status: "ended", endedAt: "2026-09-01 12:00:00+00" },
      clock: {
        trigger: "purpose_achieved",
        recipe: "dueAt = the tenant-local calendar date of endedAt, plus periodMonths calendar months",
        dueAt: null,
        reason: "hold_active",
        rules: [
          { ruleId: RULE, label: "Dossiers", labelEn: null, periodMonths: 12, action: "destroy", dueAt: "2027-09-01", held: true },
        ],
      },
      disposition: null,
      holds: [hold],
      releasedTruncated: false,
    };
    const { agreely, calls } = client([{ json: body }]);
    const r = await agreely.retention.getCustomerRetention("STORE/0042");
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/STORE%2F0042/retention`);
    expect(r.clock.reason).toBe("hold_active");
    expect(r.clock.rules[0]!.held).toBe(true);
    expect(r.holds[0]!.placedBy).toBe("api");
  });
});

describe("retention.declareDisposition", () => {
  const declared: DeclaredDisposition = {
    customerRef: "c1",
    recorded: true,
    status: "declared",
    appended: true,
    id: "d1",
    disposition: "destroyed",
    retentionUntil: null,
    hasReason: false,
    endedAtSnapshot: "2026-09-01 12:00:00+00",
    scheduleRef: null,
    basis: null,
    hasBasisNote: false,
    declaredBy: "api:billing",
    declaredAt: "2026-10-08 18:00:00+00",
    agreelyIdentity: "retained_hold",
    warnings: [{ code: "hold_active", message: "An active hold covers this customer.", holdIds: [HOLD] }],
  };

  it("posts the named members only and surfaces the hold_active warning", async () => {
    const { agreely, calls } = client([{ status: 201, json: declared }]);
    const r = await agreely.retention.declareDisposition("c1", {
      disposition: "legal_hold",
      reason: "Loi sur les impôts, art. 35",
      retentionUntil: "2032-12-31",
      scheduleRef: "R-12",
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/c1/retention/dispositions`);
    expect(calls[0]!.body).toEqual({
      disposition: "legal_hold",
      reason: "Loi sur les impôts, art. 35",
      retentionUntil: "2032-12-31",
      scheduleRef: "R-12",
    });
    expect(r.warnings[0]!.code).toBe("hold_active");
    expect(r.agreelyIdentity).toBe("retained_hold");
  });

  it("refuses an impossible declaration before any call", () => {
    const { agreely, calls } = client([{ status: 201, json: declared }]);
    const bad = [
      { disposition: "deleted" },
      { disposition: "legal_hold" },
      { disposition: "legal_hold", reason: " " },
      { disposition: "destroyed", retentionUntil: "2030-01-01" },
      { disposition: "legal_hold", reason: "law", retentionUntil: "31/12/2030" },
    ];
    for (const input of bad) {
      expect(() => agreely.retention.declareDisposition("c1", input as never)).toThrow(AgreelyConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  it("a live relationship is a 409 relationship_active, carried in code", async () => {
    const { agreely, calls } = client([
      { status: 409, json: { error: { code: "relationship_active", message: "End the relationship first." } } },
    ]);
    const err = await agreely.retention.declareDisposition("c1", { disposition: "destroyed" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect(err).toMatchObject({ code: "relationship_active" });
    expect(calls[0]!.body).toEqual({ disposition: "destroyed" });
  });
});

describe("retention.placeHold / releaseHold", () => {
  const placed: PlacedHold = { customerRef: "c1", recorded: true, replayed: false, ...hold };

  it("places a hold with the documented members and an Idempotency-Key", async () => {
    const { agreely, calls } = client([{ status: 201, json: placed }]);
    const r = await agreely.retention.placeHold(
      "c1",
      {
        ground: "other_law",
        provision: "Loi sur les impôts, art. 35",
        scope: { rules: [RULE] },
        startedOn: "2026-10-08",
        reviewOn: "2027-10-08",
      },
      { idempotencyKey: "hold-c1-1" },
    );
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/c1/retention/holds`);
    expect(calls[0]!.body).toEqual({
      ground: "other_law",
      provision: "Loi sur les impôts, art. 35",
      scope: { rules: [RULE] },
      startedOn: "2026-10-08",
      reviewOn: "2027-10-08",
    });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("hold-c1-1");
    expect(r.replayed).toBe(false);
  });

  it("sends a rights_request hold with only its ground, and an auto-generated key", async () => {
    const { agreely, calls } = client([{ status: 201, json: placed }]);
    await agreely.retention.placeHold("c1", { ground: "rights_request" });
    expect(calls[0]!.body).toEqual({ ground: "rights_request" });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^idem_/);
  });

  it("refuses an impossible hold before any call", () => {
    const { agreely, calls } = client([{ status: 201, json: placed }]);
    const bad = [
      { ground: "lawsuit" },
      { ground: "other_law" },
      { ground: "rights_request", provision: "x" },
      { ground: "rights_request", scope: {} },
      { ground: "rights_request", scope: { rules: [] } },
      { ground: "rights_request", scope: ["all"] },
      { ground: "rights_request", startedOn: "today" },
      { ground: "other_law", provision: "x".repeat(2001) },
    ];
    for (const input of bad) {
      expect(() => agreely.retention.placeHold("c1", input as never)).toThrow(AgreelyConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  it("the daily budget of placed holds is an AgreelyDailyCapError, never retried", async () => {
    const { agreely, calls } = client(
      [{ status: 429, json: { error: { code: "hold_budget_exhausted", message: "Budget." } } }, { json: placed }],
      2,
    );
    const err = await agreely.retention.placeHold("c1", { ground: "rights_request" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyDailyCapError);
    expect(err).toMatchObject({ code: "hold_budget_exhausted" });
    expect(calls).toHaveLength(1);
  });

  it("releases a hold with a reason and reports what it did to Agreely's identity copy", async () => {
    const released: ReleasedHold = {
      customerRef: "c1",
      recorded: true,
      ...hold,
      status: "released",
      placedBy: "organization",
      releasedAt: "2026-10-09T12:00:00Z",
      agreelyIdentity: "erased",
    };
    const { agreely, calls } = client([{ json: released }]);
    const r = await agreely.retention.releaseHold("c1", HOLD.toUpperCase(), { reason: "Recourse period over" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/customers/c1/retention/holds/${HOLD}/release`);
    expect(calls[0]!.body).toEqual({ reason: "Recourse period over" });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^idem_/);
    expect(r.agreelyIdentity).toBe("erased");
  });

  it("refuses a blank reason or a malformed hold id before any call", () => {
    const { agreely, calls } = client([{ json: {} }]);
    expect(() => agreely.retention.releaseHold("c1", HOLD, { reason: " " })).toThrow(AgreelyConfigError);
    expect(() => agreely.retention.releaseHold("c1", "not-a-uuid", { reason: "r" })).toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("already_released is a 409; the release cap is an AgreelyDailyCapError", async () => {
    const { agreely } = client([
      { status: 409, json: { error: { code: "already_released", message: "Released." } } },
      { status: 429, json: { error: { code: "hold_release_cap_reached", message: "Cap." } } },
    ]);
    await expect(agreely.retention.releaseHold("c1", HOLD, { reason: "r" })).rejects.toMatchObject({
      name: "AgreelyConflictError",
      code: "already_released",
    });
    await expect(agreely.retention.releaseHold("c1", HOLD, { reason: "r" })).rejects.toSatisfy(
      (e: unknown) => e instanceof AgreelyDailyCapError && e.code === "hold_release_cap_reached",
    );
  });
});

describe("retention holds feed (scope holds)", () => {
  function feedHold(id: string, status: "active" | "released" = "active"): RetentionHoldFeedItem {
    return { id, customerRef: `c-${id}`, status, scope: "all", changedAt: "2026-10-08T18:00:00Z" };
  }

  it("reads one page with changedSince and pageToken as query parameters", async () => {
    const { agreely, calls } = client([{ json: { holds: [], nextPageToken: null, cursor: "2026-10-09T11:55:00Z" } }]);
    await agreely.retention.listHolds({ changedSince: "2026-10-08T00:00:00Z", pageToken: "tok" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/retention/holds");
    expect(url.searchParams.get("changedSince")).toBe("2026-10-08T00:00:00Z");
    expect(url.searchParams.get("pageToken")).toBe("tok");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("syncHolds follows nextPageToken to the last page and returns its cursor (a snapshot)", async () => {
    const { agreely, calls } = client([
      { json: { holds: [feedHold("1"), feedHold("2")], nextPageToken: "p2", cursor: null } },
      { json: { holds: [feedHold("3")], nextPageToken: null, cursor: "2026-10-09T11:55:00Z" } },
    ]);
    const sync = await agreely.retention.syncHolds();
    expect(sync).toEqual({
      mode: "snapshot",
      holds: [feedHold("1"), feedHold("2"), feedHold("3")],
      cursor: "2026-10-09T11:55:00Z",
    });
    expect(new URL(calls[0]!.url).searchParams.has("pageToken")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.get("pageToken")).toBe("p2");
  });

  it("a sync from a cursor is a delta and keeps changedSince on every page", async () => {
    const { agreely, calls } = client([
      { json: { holds: [feedHold("1", "released")], nextPageToken: "p2", cursor: null } },
      { json: { holds: [], nextPageToken: null, cursor: "c2" } },
    ]);
    const sync = await agreely.retention.syncHolds({ changedSince: "c1" });
    expect(sync.mode).toBe("delta");
    expect(sync.cursor).toBe("c2");
    expect(calls.map((c) => new URL(c.url).searchParams.get("changedSince"))).toEqual(["c1", "c1"]);
  });

  it("holdPages yields every page, the last one carrying the cursor", async () => {
    const { agreely } = client([
      { json: { holds: [feedHold("1")], nextPageToken: "p2", cursor: null } },
      { json: { holds: [feedHold("2")], nextPageToken: null, cursor: "c" } },
    ]);
    const pages = [];
    for await (const page of agreely.retention.holdPages()) pages.push(page);
    expect(pages.map((p) => p.cursor)).toEqual([null, "c"]);
  });

  it("never returns a partial feed: running out of maxPages throws", async () => {
    const { agreely } = client([{ json: { holds: [feedHold("1")], nextPageToken: "more", cursor: null } }]);
    await expect(agreely.retention.syncHolds({ maxPages: 3 })).rejects.toBeInstanceOf(AgreelyConfigError);
  });

  it("fails closed: a refused key or a bad cursor throws, never an empty feed", async () => {
    const { agreely } = client([
      { status: 403, json: { error: { code: "forbidden", message: "This API key does not carry the 'holds' scope." } } },
      { status: 422, json: { error: { code: "invalid_request", message: "malformed", field: "changedSince" } } },
    ]);
    await expect(agreely.retention.syncHolds()).rejects.toBeInstanceOf(AgreelyAuthError);
    await expect(agreely.retention.syncHolds({ changedSince: "garbage" })).rejects.toSatisfy(
      (e: unknown) => e instanceof AgreelyValidationError && e.field === "changedSince",
    );
  });
});
