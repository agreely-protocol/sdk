import { describe, expect, it, vi } from "vitest";
import {
  Agreely,
  AgreelyAuthError,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelySweepTooFrequentError,
  AgreelyValidationError,
  type DeclarePurgeInput,
  type RetentionRule,
  type RetentionRuleSnapshot,
} from "../../src/index.js";
import { mockFetch, networkError } from "./helpers.js";

const BASE = "http://api.test";
const RULE = "0b7f3c1e-2d4a-4f5b-9c6d-7e8f9a0b1c2d";

function client(script: Parameters<typeof mockFetch>[0], maxDegradeWindow?: string) {
  const { fetch, calls } = mockFetch(script);
  return {
    agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch, ...(maxDegradeWindow ? { maxDegradeWindow } : {}) }),
    calls,
  };
}

function rule(key: string, months = 12): RetentionRule {
  return {
    key,
    label: "Dossiers clients",
    labelEn: "Customer files",
    duration: { value: months, unit: "months" },
    trigger: "purpose_achieved",
    action: "destroy",
    anonymizationProcessKey: null,
    status: "active",
    archivedAt: null,
    updatedAt: "2026-09-25T12:00:00.000000Z",
  };
}

const purge: DeclarePurgeInput = {
  ranAt: "2026-09-25T03:00:00-04:00",
  recordsAffected: 42,
  method: "destroyed",
  coveredFrom: "2025-01-01",
  coveredUntil: "2025-01-31",
  hostSystem: "billing",
  hostCategory: "invoices",
};

const stored = {
  id: "11111111-1111-4111-8111-111111111111",
  ruleKey: RULE,
  recorded: true,
  status: "declared",
  replayed: false,
  ranAt: "2026-09-25T07:00:00.000000Z",
  recordsAffected: 42,
  method: "destroyed",
  anonymizationProcessKey: null,
  coveredFrom: "2025-01-01",
  coveredUntil: "2025-01-31",
  hostSystem: "billing",
  hostCategory: "invoices",
  declaredBy: "API: nightly",
  declaredAt: "2026-09-25T07:00:01.000000Z",
  referencesRecorded: 0,
  warnings: [],
};

describe("retention.listRules / getRule", () => {
  it("reads the rules and passes changedSince as a query parameter", async () => {
    const { agreely, calls } = client([{ json: { cursor: "c", rules: [rule(RULE)], ruleKeys: [RULE] } }]);
    const r = await agreely.retention.listRules({ changedSince: "2026-09-25T00:00:00Z" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/retention/rules?changedSince=2026-09-25T00%3A00%3A00Z`);
    expect(r.ruleKeys).toEqual([RULE]);
  });

  it("maps a foreign rule to AgreelyNotFoundError", async () => {
    const { agreely } = client([{ status: 404, json: { error: { code: "not_found", message: "No retention rule with that key." } } }]);
    await expect(agreely.retention.getRule(RULE)).rejects.toBeInstanceOf(AgreelyNotFoundError);
  });
});

describe("retention.declarePurge", () => {
  it("sends the Idempotency-Key as a HEADER and never in the body", async () => {
    const { agreely, calls } = client([{ status: 201, json: stored }]);
    const r = await agreely.retention.declarePurge(RULE, purge, { idempotencyKey: "run-2026-09-25:rule-1" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/retention/rules/${RULE}/purges`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("run-2026-09-25:rule-1");
    expect(calls[0]!.body).toEqual({
      ranAt: "2026-09-25T03:00:00-04:00",
      recordsAffected: 42,
      method: "destroyed",
      coveredFrom: "2025-01-01",
      coveredUntil: "2025-01-31",
      hostSystem: "billing",
      hostCategory: "invoices",
    });
    expect(r.status).toBe("declared");
  });

  it("drops an idempotency key smuggled into the body past the types", async () => {
    const { agreely, calls } = client([{ status: 201, json: stored }]);
    const smuggled = { ...purge, idempotencyKey: "x", extra: 1 } as unknown as DeclarePurgeInput;
    await agreely.retention.declarePurge(RULE, smuggled, { idempotencyKey: "k-1" });
    expect(calls[0]!.body).not.toHaveProperty("idempotencyKey");
    expect(calls[0]!.body).not.toHaveProperty("extra");
  });

  it("sends a Date in UTC and the anonymization process with an anonymized purge", async () => {
    const { agreely, calls } = client([{ status: 201, json: stored }]);
    await agreely.retention.declarePurge(
      RULE,
      {
        ...purge,
        method: "anonymized",
        anonymizationProcessKey: "22222222-2222-4222-8222-222222222222",
        ranAt: new Date("2026-09-25T07:00:00Z"),
        references: ["A-1", "A-2"],
      },
      { idempotencyKey: "k-2" },
    );
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.ranAt).toBe("2026-09-25T07:00:00.000Z");
    expect(body.anonymizationProcessKey).toBe("22222222-2222-4222-8222-222222222222");
    expect(body.references).toEqual(["A-1", "A-2"]);
  });

  const refusals: Array<[string, () => [DeclarePurgeInput, { idempotencyKey: string }]]> = [
    ["a missing idempotency key", () => [purge, undefined as unknown as { idempotencyKey: string }]],
    ["a non-ASCII idempotency key", () => [purge, { idempotencyKey: "clé" }]],
    ["an over-long idempotency key", () => [purge, { idempotencyKey: "k".repeat(256) }]],
    ["a third method", () => [{ ...purge, method: "aggregated" } as unknown as DeclarePurgeInput, { idempotencyKey: "k" }]],
    ["the rule's action word instead of the disposition", () => [{ ...purge, method: "destroy" } as unknown as DeclarePurgeInput, { idempotencyKey: "k" }]],
    ["anonymized without a process", () => [{ ...purge, method: "anonymized" } as unknown as DeclarePurgeInput, { idempotencyKey: "k" }]],
    ["destroyed with a process", () => [{ ...purge, anonymizationProcessKey: "p" } as unknown as DeclarePurgeInput, { idempotencyKey: "k" }]],
    ["zero records", () => [{ ...purge, recordsAffected: 0 }, { idempotencyKey: "k" }]],
    ["a fractional count", () => [{ ...purge, recordsAffected: 1.5 }, { idempotencyKey: "k" }]],
    ["over a billion records", () => [{ ...purge, recordsAffected: 1_000_000_001 }, { idempotencyKey: "k" }]],
    ["more references than records", () => [{ ...purge, recordsAffected: 1, references: ["a", "b"] }, { idempotencyKey: "k" }]],
    ["over 1000 references", () => [{ ...purge, recordsAffected: 5000, references: Array.from({ length: 1001 }, (_, i) => `r${i}`) }, { idempotencyKey: "k" }]],
    ["an empty references list", () => [{ ...purge, references: [] }, { idempotencyKey: "k" }]],
    ["a naive ranAt", () => [{ ...purge, ranAt: "2026-09-25T03:00:00" }, { idempotencyKey: "k" }]],
    ["a malformed day", () => [{ ...purge, coveredFrom: "2025-1-1" }, { idempotencyKey: "k" }]],
    ["a pod name as hostSystem", () => [{ ...purge, hostSystem: "billing-7f9c8d6b5-x2x4k" }, { idempotencyKey: "k" }]],
    ["a record id as hostCategory", () => [{ ...purge, hostCategory: "client-000123" }, { idempotencyKey: "k" }]],
  ];
  for (const [name, args] of refusals) {
    it(`refuses ${name} before any wire call`, async () => {
      const { agreely, calls } = client([{ status: 201, json: stored }]);
      const [input, options] = args();
      await expect(agreely.retention.declarePurge(RULE, input, options)).rejects.toThrow(AgreelyConfigError);
      expect(calls).toHaveLength(0);
    });
  }

  it("surfaces a 409 retry as AgreelyConflictError, not as an outage or a rate limit", async () => {
    const { agreely, calls } = client([
      { status: 409, json: { error: { code: "retry", message: "The declaration could not be settled; retry with the same Idempotency-Key." } } },
    ]);
    const err = await agreely.retention.declarePurge(RULE, purge, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyConflictError);
    expect((err as AgreelyConflictError).code).toBe("retry");
    expect(calls).toHaveLength(1);
  });

  it("surfaces idempotency_key_reused as a validation error carrying its code", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "idempotency_key_reused", message: "reused" } } },
    ]);
    const err = await agreely.retention.declarePurge(RULE, purge, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyValidationError);
    expect((err as AgreelyValidationError).code).toBe("idempotency_key_reused");
  });

  it("never retries a purge on a 503", async () => {
    const { agreely, calls } = client([{ status: 503 }, { status: 201, json: stored }]);
    await expect(agreely.retention.declarePurge(RULE, purge, { idempotencyKey: "k" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("retention.declareSweep", () => {
  const sweep = {
    id: "33333333-3333-4333-8333-333333333333",
    ruleKey: RULE,
    recorded: true,
    status: "declared",
    declaredNothingDue: true,
    replayed: false,
    sweptAt: "2026-09-25T07:00:00.000000Z",
    hostSystem: "billing",
    declaredBy: "API: nightly",
    declaredAt: "2026-09-25T07:00:01.000000Z",
  };

  it("posts sweptAt and hostSystem with the key in the header", async () => {
    const { agreely, calls } = client([{ status: 201, json: sweep }]);
    const now = new Date();
    await agreely.retention.declareSweep(RULE, { sweptAt: now, hostSystem: "billing" }, { idempotencyKey: "s-1" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/retention/rules/${RULE}/sweeps`);
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("s-1");
    expect(calls[0]!.body).toEqual({ sweptAt: now.toISOString(), hostSystem: "billing" });
  });

  it("refuses a sweptAt older than 24 hours before any wire call", async () => {
    const { agreely, calls } = client([{ status: 201, json: sweep }]);
    const yesterday = new Date(Date.now() - 25 * 3_600_000);
    await expect(agreely.retention.declareSweep(RULE, { sweptAt: yesterday, hostSystem: "billing" }, { idempotencyKey: "s" }),).rejects.toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the 15-minute floor as a typed, catchable AgreelySweepTooFrequentError and never retries it", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 429,
        headers: { "Retry-After": "600" },
        json: { error: { code: "sweep_too_frequent", message: "A pass was already declared..." } },
      },
      { status: 201, json: sweep },
    ]);
    // Even with 429 retries switched on, a declaration is never retried.
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch, maxRetries: 3 });
    const err = await agreely.retention
      .declareSweep(RULE, { sweptAt: new Date(), hostSystem: "billing" }, { idempotencyKey: "s" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelySweepTooFrequentError);
    expect(err).toBeInstanceOf(AgreelyRateLimitError);
    expect((err as AgreelySweepTooFrequentError).code).toBe("sweep_too_frequent");
    expect((err as AgreelySweepTooFrequentError).retryAfterSeconds).toBe(600);
    expect(calls).toHaveLength(1);
  });

  it("keeps the company rate window a plain AgreelyRateLimitError", async () => {
    const { agreely } = client([{ status: 429, json: { error: { code: "rate_limited", message: "slow down" } } }]);
    const err = await agreely.retention
      .declareSweep(RULE, { sweptAt: new Date(), hostSystem: "billing" }, { idempotencyKey: "s" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyRateLimitError);
    expect(err).not.toBeInstanceOf(AgreelySweepTooFrequentError);
  });
});

describe("catalog.listCells", () => {
  it("reads the cells with their governing rule", async () => {
    const body = {
      regime: { sector: "private", statute: "P-39.1" },
      cells: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          category: "Coordonnées",
          purpose: "Facturation",
          description: null,
          legalBasis: "contract",
          sensitive: false,
          categoryEn: null,
          purposeEn: null,
          status: "active",
          retentionRuleKey: null,
        },
      ],
    };
    const { agreely, calls } = client([{ json: body }]);
    const r = await agreely.catalog.listCells();
    expect(calls[0]!.url).toBe(`${BASE}/v1/catalog/cells`);
    expect(r.cells[0]!.retentionRuleKey).toBeNull();
  });
});

describe("retention.rulesForPurge (degrade)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function snapshot(ageMs: number, rules: RetentionRule[] = [rule(A), rule(B)]): RetentionRuleSnapshot {
    return { cursor: "2026-09-24T00:00:00.000000Z", fetchedAt: new Date(Date.now() - ageMs).toISOString(), rules };
  }

  it("reads every rule live when there is no snapshot", async () => {
    const { agreely, calls } = client([{ json: { cursor: "c1", rules: [rule(A)], ruleKeys: [A] } }]);
    const r = await agreely.retention.rulesForPurge();
    expect(r.source).toBe("live");
    if (r.source !== "live") return;
    expect(r.rules.map((x) => x.key)).toEqual([A]);
    expect(r.snapshot.cursor).toBe("c1");
    expect(calls[0]!.url).toBe(`${BASE}/v1/retention/rules`);
  });

  it("merges an incremental read and drops a rule whose key disappeared", async () => {
    const { agreely, calls } = client([
      { json: { cursor: "c2", rules: [rule(B, 84), rule(C)], ruleKeys: [B, C] } },
    ]);
    const r = await agreely.retention.rulesForPurge({ snapshot: snapshot(3_600_000) });
    expect(calls[0]!.url).toContain("changedSince=");
    if (r.source !== "live") throw new Error("expected live");
    expect(r.rules.map((x) => [x.key, x.duration.value])).toEqual([
      [B, 84],
      [C, 12],
    ]);
    expect(r.snapshot.cursor).toBe("c2");
  });

  it("falls back to one full read when the merge cannot account for a current key", async () => {
    const { agreely, calls } = client([
      { json: { cursor: "c2", rules: [], ruleKeys: [A, C] } },
      { json: { cursor: "c3", rules: [rule(A), rule(C)], ruleKeys: [A, C] } },
    ]);
    const r = await agreely.retention.rulesForPurge({ snapshot: snapshot(1000) });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(`${BASE}/v1/retention/rules`);
    if (r.source !== "live") throw new Error("expected live");
    expect(r.rules.map((x) => x.key)).toEqual([A, C]);
  });

  it("ABSTAINS by default on an outage, even with a fresh snapshot", async () => {
    const { agreely } = client([{ throw: networkError() }]);
    const r = await agreely.retention.rulesForPurge({ snapshot: snapshot(60_000) });
    expect(r.source).toBe("abstain");
    if (r.source === "abstain") expect(r.reason).toBe("outage");
    expect(r).not.toHaveProperty("rules");
  });

  it("uses a fresh snapshot on an outage only when opted in, and records the evidence", async () => {
    const { agreely } = client([{ status: 503 }]);
    const onDegrade = vi.fn();
    const snap = snapshot(3_600_000);
    const r = await agreely.retention.rulesForPurge({
      snapshot: snap,
      onOutage: "use-snapshot",
      maxSnapshotAge: "2h",
      onDegrade,
    });
    expect(r.source).toBe("snapshot");
    if (r.source !== "snapshot") return;
    expect(r.rules).toBe(snap.rules);
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(onDegrade.mock.calls[0]![0].snapshotFetchedAt).toBe(snap.fetchedAt);
  });

  it("abstains when the opted-in snapshot is older than maxSnapshotAge, or missing", async () => {
    const onDegrade = vi.fn();
    const old = await client([{ status: 503 }]).agreely.retention.rulesForPurge({
      snapshot: snapshot(3 * 3_600_000),
      onOutage: "use-snapshot",
      maxSnapshotAge: "2h",
      onDegrade,
    });
    expect(old.source === "abstain" && old.reason).toBe("snapshot_too_old");
    const none = await client([{ status: 503 }]).agreely.retention.rulesForPurge({
      onOutage: "use-snapshot",
      maxSnapshotAge: "2h",
      onDegrade,
    });
    expect(none.source === "abstain" && none.reason).toBe("no_snapshot");
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("THROWS a non-outage failure rather than abstaining quietly", async () => {
    const { agreely } = client([{ status: 403, json: { error: { code: "forbidden", message: "no retention scope" } } }]);
    await expect(
      agreely.retention.rulesForPurge({ snapshot: snapshot(1000), onOutage: "use-snapshot", maxSnapshotAge: "2h", onDegrade: () => {} }),
    ).rejects.toBeInstanceOf(AgreelyAuthError);
  });

  it("validates the degrade options before any wire call", async () => {
    const { agreely, calls } = client([{ json: { cursor: "c", rules: [], ruleKeys: [] } }]);
    await expect(
      agreely.retention.rulesForPurge({ onOutage: "use-snapshot", maxSnapshotAge: "48h", onDegrade: () => {} }),
    ).rejects.toBeInstanceOf(AgreelyConfigError);
    await expect(
      agreely.retention.rulesForPurge({
        onOutage: "use-snapshot",
        maxSnapshotAge: "2h",
        onDegrade: undefined as unknown as () => void,
      }),
    ).rejects.toBeInstanceOf(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("accepts a nightly snapshot once maxDegradeWindow is raised", async () => {
    const { agreely } = client([{ status: 503 }], "30h");
    const r = await agreely.retention.rulesForPurge({
      snapshot: snapshot(25 * 3_600_000),
      onOutage: "use-snapshot",
      maxSnapshotAge: "26h",
      onDegrade: () => {},
    });
    expect(r.source).toBe("snapshot");
  });
});
