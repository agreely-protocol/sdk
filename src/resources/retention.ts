import { decideRulesOnOutage, retentionOutageWindow } from "../degrade.js";
import { AgreelyConfigError, AgreelyUnavailableError, AgreelyValidationError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  DeclarationOptions,
  DeclarePurgeInput,
  DeclareSweepInput,
  ListRetentionRulesInput,
  PurgeDeclaration,
  RetentionRule,
  RetentionRuleDetail,
  RetentionRuleList,
  RetentionRuleSnapshot,
  RetentionSweep,
  RulesForPurge,
  RulesForPurgeOptions,
} from "../types.js";
import {
  DEFAULT_MAX_DEGRADE_WINDOW_MS,
  assertHostToken,
  assertIdempotencyKey,
  toWireInstant,
} from "../util.js";

/** recordsAffected upper bound, mirrored from the server. */
export const PURGE_RECORDS_MAX = 1_000_000_000;

/** At most this many references per purge declaration; a larger purge is declared in several. */
export const PURGE_REFERENCES_MAX = 1000;

/** A sweep's `sweptAt` must fall within this window before now. */
export const SWEEP_MAX_AGE_MS = 24 * 3_600_000;

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The host-retention resource (scope: 'retention'). Agreely DECIDES the rules and
 * RECORDS what the host declares; the host reads the decisions, runs its purges,
 * and DECLARES them. Agreely observes nothing in the host's systems and verifies
 * none of it: every write response says `status: "declared"`, never "verified".
 *
 * Neither declaration is ever auto-retried, and both REQUIRE an Idempotency-Key
 * passed as the third argument, never in the body (see {@link DeclarationOptions}
 * for the key-rotation trap).
 */
export class Retention {
  constructor(
    private readonly transport: Transport,
    private readonly maxDegradeWindowMs: number = DEFAULT_MAX_DEGRADE_WINDOW_MS,
  ) {}

  /**
   * Every rule the organisation decided (archived ones included), or only those
   * changed since `changedSince` (a previous response's `cursor`). `ruleKeys` is
   * always the complete current key set. A purge job wants
   * {@link Retention.rulesForPurge}, which does the incremental merge and the
   * outage decision for you.
   */
  listRules(input: ListRetentionRulesInput = {}): Promise<RetentionRuleList> {
    return this.transport.request<RetentionRuleList>({
      method: "GET",
      path: "/v1/retention/rules",
      query: { changedSince: input.changedSince },
      idempotentRetry: true,
    });
  }

  /**
   * One rule, plus the instants of the host's last declared purge and pass under
   * it. An unknown, foreign or malformed key is the same AgreelyNotFoundError.
   */
  getRule(ruleKey: string): Promise<RetentionRuleDetail> {
    return this.transport.request<RetentionRuleDetail>({
      method: "GET",
      path: `/v1/retention/rules/${encodeURIComponent(requireRuleKey(ruleKey, "retention.getRule"))}`,
      idempotentRetry: true,
    });
  }

  /**
   * The rules a purge job may act on THIS run, with the outage decided for it.
   *
   * Agreely answers: the rules are read (incrementally when you pass the previous
   * run's `snapshot`) and returned with a fresh `snapshot` to persist.
   *
   * Agreely is unreachable (503, network, timeout): by DEFAULT the result is
   * `source: "abstain"`, and the job must not purge this run. Missing a SHORTENED
   * rule keeps data a little too long; missing a LENGTHENED rule (a legal hold)
   * destroys what had to be kept, and that does not repair. Opting into
   * `onOutage: "use-snapshot"` accepts that second risk, bounded by
   * `maxSnapshotAge` and recorded through the mandatory `onDegrade`.
   *
   * Anything else (401/403, 402, 422, 429) THROWS: it is not an outage, and
   * treating it as one would hide a key or billing problem behind a skipped run.
   * The options are validated before any wire call.
   */
  async rulesForPurge(options: RulesForPurgeOptions = {}): Promise<RulesForPurge> {
    const maxSnapshotAgeMs = retentionOutageWindow(options, this.maxDegradeWindowMs);
    try {
      const snapshot = await this.sync(options.snapshot ?? null);
      return { source: "live", rules: snapshot.rules, snapshot };
    } catch (error) {
      if (!(error instanceof AgreelyUnavailableError)) throw error;
      return decideRulesOnOutage(options, maxSnapshotAgeMs, error);
    }
  }

  /**
   * DECLARE a purge the host's system ran under a rule. 201 records it; the same
   * Idempotency-Key with the same declaration replays the STORED one (`replayed:
   * true`); the same key with a different declaration is a 422
   * `idempotency_key_reused`. A 409 is AgreelyConflictError: retry with the SAME
   * key. A method that differs from the rule's action is recorded and flagged in
   * `warnings`, never refused.
   *
   * Refused client-side, before any wire call (AgreelyConfigError): a missing or
   * malformed idempotencyKey, a method other than `destroyed` / `anonymized`, an
   * `anonymized` purge without its process key (or a `destroyed` one with one),
   * `recordsAffected` outside 1..1,000,000,000 (a pass that found nothing is
   * {@link Retention.declareSweep}), more references than 1000 or than
   * `recordsAffected`, and a malformed host token, instant or day.
   *
   * The body is built from the named fields only, so nothing else you pass,
   * including an idempotency key, can reach it. Never auto-retried.
   */
  declarePurge(
    ruleKey: string,
    input: DeclarePurgeInput,
    options: DeclarationOptions,
  ): Promise<PurgeDeclaration> {
    const label = "retention.declarePurge";
    const key = requireRuleKey(ruleKey, label);
    const idempotencyKey = assertIdempotencyKey(options, label);

    const method: unknown = input.method;
    if (method !== "destroyed" && method !== "anonymized") {
      throw new AgreelyConfigError(
        `${label}: method must be "destroyed" or "anonymized", the two dispositions the acts know. ` +
          `Aggregation is a technique, not a third disposition. (The rule's own action reads "destroy" / ` +
          `"anonymize"; a declaration says what was done.)`,
      );
    }
    const processKey: unknown = input.anonymizationProcessKey;
    if (method === "anonymized" && (typeof processKey !== "string" || processKey.trim() === "")) {
      throw new AgreelyConfigError(
        `${label}: an "anonymized" purge requires anonymizationProcessKey, the process that was applied. ` +
          `It is never defaulted from the rule.`,
      );
    }
    if (method === "destroyed" && processKey !== undefined) {
      throw new AgreelyConfigError(`${label}: a "destroyed" purge takes no anonymizationProcessKey.`);
    }

    const records = input.recordsAffected;
    if (!Number.isInteger(records) || records > PURGE_RECORDS_MAX) {
      throw new AgreelyConfigError(
        `${label}: recordsAffected must be a whole number from 1 to ${PURGE_RECORDS_MAX}.`,
      );
    }
    if (records < 1) {
      throw new AgreelyConfigError(
        `${label}: recordsAffected must be at least 1. A pass that found nothing to purge is a sweep: ` +
          `call retention.declareSweep instead.`,
      );
    }

    const references = input.references;
    if (references !== undefined) {
      if (!Array.isArray(references) || references.length === 0) {
        throw new AgreelyConfigError(`${label}: references, when given, is a non-empty array. Omit it otherwise.`);
      }
      if (references.length > PURGE_REFERENCES_MAX) {
        throw new AgreelyConfigError(
          `${label}: at most ${PURGE_REFERENCES_MAX} references per declaration. Declare a larger purge in ` +
            `several declarations, each with its own idempotencyKey.`,
        );
      }
      if (references.length > records) {
        throw new AgreelyConfigError(`${label}: references cannot outnumber recordsAffected.`);
      }
      if (references.some((r) => typeof r !== "string")) {
        throw new AgreelyConfigError(`${label}: every reference is a string.`);
      }
    }

    const body = {
      ranAt: toWireInstant(input.ranAt, `${label}: ranAt`).wire,
      recordsAffected: records,
      method,
      ...(method === "anonymized" ? { anonymizationProcessKey: processKey } : {}),
      coveredFrom: requireDay(input.coveredFrom, `${label}: coveredFrom`),
      coveredUntil: requireDay(input.coveredUntil, `${label}: coveredUntil`),
      hostSystem: assertHostToken(input.hostSystem, `${label}: hostSystem`),
      hostCategory: assertHostToken(input.hostCategory, `${label}: hostCategory`),
      ...(references !== undefined ? { references } : {}),
    };

    return this.transport.request<PurgeDeclaration>({
      method: "POST",
      path: `/v1/retention/rules/${encodeURIComponent(key)}/purges`,
      body,
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * DECLARE a pass under a rule that found nothing to purge: the heartbeat that
   * tells a host with nothing to purge apart from a host that stopped purging. It
   * records what the host SAID, never that nothing was due.
   *
   * THE FLOOR: one pass per (rule, hostSystem) every 15 minutes. A second one is
   * AgreelySweepTooFrequentError (a typed 429 with `retryAfterSeconds`), which the
   * SDK never retries. Do not loop on it: the pass already declared stands for
   * this one. Two systems sharing a rule never block each other.
   *
   * `sweptAt` must fall within the last 24 hours: an older one (a queued retry
   * from yesterday, a skewed clock) is refused client-side, since the server would
   * refuse it too. Never auto-retried.
   */
  declareSweep(
    ruleKey: string,
    input: DeclareSweepInput,
    options: DeclarationOptions,
  ): Promise<RetentionSweep> {
    const label = "retention.declareSweep";
    const key = requireRuleKey(ruleKey, label);
    const idempotencyKey = assertIdempotencyKey(options, label);
    const sweptAt = toWireInstant(input.sweptAt, `${label}: sweptAt`);
    if (Date.now() - sweptAt.ms > SWEEP_MAX_AGE_MS) {
      throw new AgreelyConfigError(
        `${label}: sweptAt must fall within the last 24 hours. A pass older than that can no longer be declared.`,
      );
    }
    return this.transport.request<RetentionSweep>({
      method: "POST",
      path: `/v1/retention/rules/${encodeURIComponent(key)}/sweeps`,
      body: {
        sweptAt: sweptAt.wire,
        hostSystem: assertHostToken(input.hostSystem, `${label}: hostSystem`),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * Bring a snapshot up to date. With a snapshot, only the rules changed since its
   * cursor are read, merged over the stored ones, and every rule whose key left
   * `ruleKeys` is dropped. A refused cursor, or a current key the merge cannot
   * account for, falls back to one full read rather than guessing.
   */
  private async sync(snapshot: RetentionRuleSnapshot | null): Promise<RetentionRuleSnapshot> {
    if (snapshot !== null && typeof snapshot.cursor === "string" && Array.isArray(snapshot.rules)) {
      let changed: RetentionRuleList | null = null;
      try {
        changed = await this.listRules({ changedSince: snapshot.cursor });
      } catch (error) {
        if (!(error instanceof AgreelyValidationError)) throw error;
      }
      if (changed !== null) {
        const merged = new Map<string, RetentionRule>();
        for (const rule of snapshot.rules) merged.set(rule.key, rule);
        for (const rule of changed.rules) merged.set(rule.key, rule);
        const rules: RetentionRule[] = [];
        let complete = true;
        for (const key of changed.ruleKeys) {
          const rule = merged.get(key);
          if (rule === undefined) {
            complete = false;
            break;
          }
          rules.push(rule);
        }
        if (complete) return { cursor: changed.cursor, fetchedAt: new Date().toISOString(), rules };
      }
    }
    const full = await this.listRules();
    return { cursor: full.cursor, fetchedAt: new Date().toISOString(), rules: full.rules };
  }
}

function requireRuleKey(ruleKey: unknown, label: string): string {
  const key = typeof ruleKey === "string" ? ruleKey.trim() : "";
  if (key === "") throw new AgreelyConfigError(`${label} requires a ruleKey.`);
  return key;
}

function requireDay(value: unknown, label: string): string {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) {
    throw new AgreelyConfigError(`${label} must be a calendar date, YYYY-MM-DD.`);
  }
  return value;
}
