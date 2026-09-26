// COMPILE-TIME refusals. Every @ts-expect-error below is a guard: `npm run
// typecheck` FAILS ("Unused '@ts-expect-error' directive") the day the line it
// sits on starts compiling. The runtime bodies never execute (the functions are
// only declared), so this file proves the types, not the wire.
import { describe, expect, it } from "vitest";
import type { Agreely, DeclarePurgeInput, RulesForPurge } from "../../src/index.js";

const base = {
  ranAt: "2026-09-25T03:00:00-04:00",
  recordsAffected: 1,
  coveredFrom: "2025-01-01",
  coveredUntil: "2025-01-31",
  hostSystem: "billing",
  hostCategory: "invoices",
} as const;

// @ts-expect-error a third method does not exist: aggregation is a technique, not a disposition.
export const aggregated: DeclarePurgeInput = { ...base, method: "aggregated" };

// @ts-expect-error the RULE's action word is not a declared disposition.
export const ruleWord: DeclarePurgeInput = { ...base, method: "destroy" };

// @ts-expect-error an anonymized purge must name the process that was applied.
export const anonymizedWithoutProcess: DeclarePurgeInput = { ...base, method: "anonymized" };

// @ts-expect-error a destroyed purge takes no anonymization process.
export const destroyedWithProcess: DeclarePurgeInput = { ...base, method: "destroyed", anonymizationProcessKey: "p" };

// @ts-expect-error the Idempotency-Key is a header, never a body field.
export const keyInBody: DeclarePurgeInput = { ...base, method: "destroyed", idempotencyKey: "k" };

export function widenedMethod(method: string): DeclarePurgeInput {
  // @ts-expect-error a plain string is not a disposition: narrow it first.
  return { ...base, method };
}

export function missingKey(agreely: Agreely): void {
  // @ts-expect-error declarePurge requires the idempotency options.
  void agreely.retention.declarePurge("r", { ...base, method: "destroyed" });
  // @ts-expect-error declareSweep requires the idempotency options.
  void agreely.retention.declareSweep("r", { sweptAt: new Date(), hostSystem: "billing" });
  // @ts-expect-error the options must carry the key itself.
  void agreely.retention.declareSweep("r", { sweptAt: new Date(), hostSystem: "billing" }, {});
  // @ts-expect-error the key is not a body field of a sweep either.
  void agreely.retention.declareSweep("r", { sweptAt: new Date(), hostSystem: "billing", idempotencyKey: "k" }, { idempotencyKey: "k" });
}

export function purgeOnAbstain(result: RulesForPurge): number {
  // @ts-expect-error an abstain result carries no rules: narrow on source first.
  return result.rules.length;
}

export function useSnapshotWithoutEvidence(agreely: Agreely): void {
  // @ts-expect-error purging on stored rules requires maxSnapshotAge and onDegrade.
  void agreely.retention.rulesForPurge({ onOutage: "use-snapshot" });
}

describe("retention compile-time guards", () => {
  it("are enforced by `npm run typecheck`, which includes this file", () => {
    expect(typeof widenedMethod).toBe("function");
  });
});
