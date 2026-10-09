import { decideRulesOnOutage, retentionOutageWindow } from "../degrade.js";
import { AgreelyConfigError, AgreelyUnavailableError, AgreelyValidationError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  CustomerRetention,
  DeclarationOptions,
  DeclareDispositionInput,
  DeclaredDisposition,
  DeclarePurgeInput,
  DeclareSweepInput,
  HoldOptions,
  HoldsSync,
  ListHoldsInput,
  ListRetentionRulesInput,
  PlacedHold,
  PlaceHoldInput,
  PurgeDeclaration,
  ReleasedHold,
  ReleaseHoldInput,
  RetentionHoldFeedItem,
  RetentionHoldPage,
  RetentionRule,
  RetentionRuleDetail,
  RetentionRuleList,
  RetentionRuleSnapshot,
  RetentionSweep,
  RulesForPurge,
  RulesForPurgeOptions,
  SyncHoldsInput,
} from "../types.js";
import {
  DEFAULT_MAX_DEGRADE_WINDOW_MS,
  assertHostToken,
  assertIdempotencyKey,
  assertUuid,
  recordIdempotencyKey,
  requireCustomerRef,
  requireDay,
  toWireInstant,
} from "../util.js";

/** recordsAffected upper bound, mirrored from the server. */
export const PURGE_RECORDS_MAX = 1_000_000_000;

/** At most this many references per purge declaration; a larger purge is declared in several. */
export const PURGE_REFERENCES_MAX = 1000;

/** A sweep's `sweptAt` must fall within this window before now. */
export const SWEEP_MAX_AGE_MS = 24 * 3_600_000;

/** At most this many characters of free text (a provision, a release or disposition reason), mirrored from the server. */
export const RETENTION_TEXT_MAX = 2000;

/** Default bound on the pages one holds sync reads (500 holds a page). */
const DEFAULT_MAX_HOLD_PAGES = 1000;

/**
 * The host-retention resource. Agreely DECIDES the rules and RECORDS what the host
 * declares; the host reads the decisions, runs its purges, and DECLARES them. Agreely
 * observes nothing in the host's systems and verifies none of it: every write response
 * says `recorded` / `declared`, never "verified".
 *
 * Scopes differ per method:
 *   'retention'  listRules, getRule, rulesForPurge, declarePurge, declareSweep
 *   'registry'   getCustomerRetention, declareDisposition, placeHold, releaseHold
 *   'holds'      listHolds, holdPages, syncHolds (the feed a purge job reads; never
 *                granted by default, so a purge job's key carries 'retention' AND 'holds')
 *
 * Neither purge declaration is ever auto-retried, and both REQUIRE an Idempotency-Key
 * passed as the third argument, never in the body (see {@link DeclarationOptions}
 * for the key-rotation trap).
 *
 * On the per-customer and hold routes a refusal carries its stable string in `code`
 * (`relationship_active`, `already_released`, `too_many_holds`, ...), not in `reason`.
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
   * The art. 23 / art. 73 posture of ONE customer (scope 'registry'): the relationship's
   * lifecycle, the clock DERIVED from the rules the organisation declared (with its
   * recipe, so you recompute rather than trust), the standing disposition, and the holds.
   *
   * `clock.dueAt` is the earliest horizon of a rule NO hold suspends; it is null with
   * `clock.reason` saying which "nothing" it is: `no_declared_rule` (never a defaulted
   * period), `relationship_active` (no anchor yet) or `hold_active` (every rule held).
   * A rule with `held: true` keeps its arithmetic `dueAt`, which is not a date to act on.
   * Metadata only: no justification or provision text is ever returned. An unknown or
   * foreign ref is AgreelyNotFoundError. A read; safe to auto-retry on a transient outage.
   */
  getCustomerRetention(customerRef: string): Promise<CustomerRetention> {
    const ref = requireCustomerRef(customerRef, "retention.getCustomerRetention");
    return this.transport.request<CustomerRetention>({
      method: "GET",
      path: `/v1/customers/${encodeURIComponent(ref)}/retention`,
      idempotentRetry: true,
    });
  }

  /**
   * DECLARE what your system did with the personal information it holds about one
   * customer once the relationship ENDED (scope 'registry'): `destroyed`, `anonymized` or
   * `legal_hold`. Append-only: a correction is a new declaration that supersedes the
   * standing one. Re-sending the declaration that stands replays it (`appended: false`,
   * HTTP 200) instead of writing a twin.
   *
   * The relationship must have ended first (`relationships.end`, its own scope): a 409
   * `relationship_active` otherwise, never an implicit end. A declaration while a hold
   * covers the customer is recorded as received with a `hold_active` warning, never
   * refused. `agreelyIdentity` says what it did to Agreely's own copy of the identity.
   *
   * Refused client-side: a disposition outside the three, a `legal_hold` without a
   * reason, a `retentionUntil` on anything but a `legal_hold` or not YYYY-MM-DD, a reason
   * or scheduleRef that is not a string. Never auto-retried.
   */
  declareDisposition(customerRef: string, input: DeclareDispositionInput): Promise<DeclaredDisposition> {
    const label = "retention.declareDisposition";
    const ref = requireCustomerRef(customerRef, label);
    const disposition: unknown = input.disposition;
    if (disposition !== "destroyed" && disposition !== "anonymized" && disposition !== "legal_hold") {
      throw new AgreelyConfigError(`${label}: disposition must be "destroyed", "anonymized" or "legal_hold".`);
    }
    const reason = optionalText(input.reason, `${label}: reason`);
    if (disposition === "legal_hold" && (reason === undefined || reason.trim() === "")) {
      throw new AgreelyConfigError(
        `${label}: a "legal_hold" requires a reason naming the law that imposes the retention delay.`,
      );
    }
    const retentionUntil: unknown = input.retentionUntil;
    if (retentionUntil !== undefined && disposition !== "legal_hold") {
      throw new AgreelyConfigError(`${label}: retentionUntil applies only to a "legal_hold".`);
    }
    const scheduleRef = optionalText(input.scheduleRef, `${label}: scheduleRef`);
    return this.transport.request<DeclaredDisposition>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(ref)}/retention/dispositions`,
      body: {
        disposition,
        ...(reason !== undefined ? { reason } : {}),
        ...(retentionUntil !== undefined ? { retentionUntil: requireDay(retentionUntil, `${label}: retentionUntil`) } : {}),
        ...(scheduleRef !== undefined ? { scheduleRef } : {}),
      },
      idempotentRetry: false,
    });
  }

  /**
   * PLACE a retention hold on one customer (scope 'registry'): the information it covers
   * must be kept, whatever the rules say, until the hold is released. `rights_request`
   * (the information is the subject of an access or rectification request) or
   * `other_law` (with the provision that requires keeping it). A hold placed here is
   * never linked to a rights request: that link is made only inside Agreely.
   *
   * Answers 201, or 200 with `replayed: true` when the same Idempotency-Key and body
   * replay the first answer. Refusals (stable string in `code`): 422 `unknown_field`,
   * `too_many_holds`, `invalid_request` with `field`; 429 AgreelyDailyCapError
   * `hold_budget_exhausted` (the API's daily budget of placed holds).
   *
   * Refused client-side: a ground outside the two, a missing provision on `other_law`
   * or one on `rights_request`, a scope that is neither "all" nor at least one rule or
   * cell key, a startedOn / reviewOn that is not YYYY-MM-DD. The body carries only the
   * documented members. Never auto-retried; the Idempotency-Key is auto-generated unless
   * you pass a durable one.
   */
  placeHold(customerRef: string, input: PlaceHoldInput, options: HoldOptions = {}): Promise<PlacedHold> {
    const label = "retention.placeHold";
    const ref = requireCustomerRef(customerRef, label);
    const ground: unknown = input.ground;
    if (ground !== "rights_request" && ground !== "other_law") {
      throw new AgreelyConfigError(`${label}: ground must be "rights_request" or "other_law".`);
    }
    const provision = optionalText(input.provision, `${label}: provision`);
    if (ground === "other_law" && (provision === undefined || provision.trim() === "")) {
      throw new AgreelyConfigError(
        `${label}: an "other_law" hold requires the provision of the law that requires the information to be kept.`,
      );
    }
    if (ground === "rights_request" && provision !== undefined) {
      throw new AgreelyConfigError(`${label}: provision applies only to an "other_law" hold.`);
    }
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, label);
    return this.transport.request<PlacedHold>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(ref)}/retention/holds`,
      body: {
        ground,
        ...(provision !== undefined ? { provision } : {}),
        ...(input.scope !== undefined ? { scope: holdScope(input.scope, label) } : {}),
        ...(input.startedOn !== undefined ? { startedOn: requireDay(input.startedOn, `${label}: startedOn`) } : {}),
        ...(input.reviewOn !== undefined ? { reviewOn: requireDay(input.reviewOn, `${label}: reviewOn`) } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * RELEASE one active hold of the organisation, with a reason (scope 'registry'). Any
   * active hold may be released here, including one the organisation placed in Agreely:
   * the answer then says `placedBy: "organization"`, the owner is notified, and the
   * company's keys may release a capped number of those per 24 hours (429
   * AgreelyDailyCapError `hold_release_cap_reached`).
   *
   * When this was the last hold on ALL the customer's information and a destroyed or
   * anonymized declaration stands, the release removes the name, email, basis note and
   * notice language from Agreely's registry record, irreversibly: `agreelyIdentity`
   * answers `erased`.
   *
   * Refusals (stable string in `code`): 404 for an unknown, foreign or other customer's
   * hold; 409 `already_released`. A blank reason or a hold id that is not a uuid is
   * refused client-side. Never auto-retried.
   */
  releaseHold(
    customerRef: string,
    holdId: string,
    input: ReleaseHoldInput,
    options: HoldOptions = {},
  ): Promise<ReleasedHold> {
    const label = "retention.releaseHold";
    const ref = requireCustomerRef(customerRef, label);
    const id = assertUuid(holdId, `${label}: holdId`);
    const reason = optionalText(input.reason, `${label}: reason`);
    if (reason === undefined || reason.trim() === "") {
      throw new AgreelyConfigError(`${label} requires a reason: releasing a hold is a motivated act.`);
    }
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, label);
    return this.transport.request<ReleasedHold>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(ref)}/retention/holds/${id}/release`,
      body: { reason },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * ONE page of the host feed of retention holds (scope 'holds'): references plus scope,
   * never the ground. Without `changedSince` it is the SNAPSHOT of every active hold;
   * with the previous sync's `cursor` it is the DELTA of every hold placed or released
   * since. Pass `nextPageToken` back as `pageToken` until a page answers `cursor`.
   * Most jobs want {@link Retention.syncHolds}. A read; safe to auto-retry.
   */
  listHolds(input: ListHoldsInput = {}): Promise<RetentionHoldPage> {
    return this.transport.request<RetentionHoldPage>({
      method: "GET",
      path: "/v1/retention/holds",
      query: { changedSince: input.changedSince, pageToken: input.pageToken },
      idempotentRetry: true,
    });
  }

  /**
   * Every page of one sync, as an async iterable, following `nextPageToken` for you.
   * The LAST page carries `cursor`. Bounded by `maxPages` (default 1000).
   *
   *   for await (const page of agreely.retention.holdPages({ changedSince })) { ... }
   */
  async *holdPages(input: SyncHoldsInput = {}): AsyncGenerator<RetentionHoldPage, void, unknown> {
    const maxPages = input.maxPages !== undefined && input.maxPages > 0 ? input.maxPages : DEFAULT_MAX_HOLD_PAGES;
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listHolds({
        ...(input.changedSince !== undefined ? { changedSince: input.changedSince } : {}),
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      yield result;
      if (result.nextPageToken === null || result.nextPageToken === undefined) return;
      pageToken = result.nextPageToken;
    }
  }

  /**
   * One complete sync of the holds feed: every page read, collected, with the `cursor`
   * to persist for the next sync. `mode: "snapshot"` (no `changedSince`) REPLACES your
   * whole active set; `mode: "delta"` lists every hold placed or released since, each
   * with its status. Delivery is at least once: upsert by `id`.
   *
   * FAIL CLOSED: purge only after this resolves. Any error (401, 403, 402, a 5xx, a
   * timeout) THROWS, and a purge job treats it as "do not purge this run". Reading
   * `maxPages` pages without reaching the last one throws AgreelyConfigError rather
   * than returning a partial feed.
   */
  async syncHolds(input: SyncHoldsInput = {}): Promise<HoldsSync> {
    const holds: RetentionHoldFeedItem[] = [];
    for await (const page of this.holdPages(input)) {
      holds.push(...page.holds);
      if (typeof page.cursor === "string" && page.cursor !== "") {
        return { mode: input.changedSince !== undefined ? "delta" : "snapshot", holds, cursor: page.cursor };
      }
    }
    throw new AgreelyConfigError(
      "retention.syncHolds stopped before the last page of the holds feed (no cursor): raise maxPages. " +
        "Do not purge on a partial feed.",
    );
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


/** An optional free-text member: a string of at most RETENTION_TEXT_MAX characters when given. */
function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || [...value].length > RETENTION_TEXT_MAX) {
    throw new AgreelyConfigError(`${label} must be a string of at most ${RETENTION_TEXT_MAX} characters.`);
  }
  return value;
}

/** A hold scope for the wire: "all", or at least one rule key or cell id. */
function holdScope(scope: unknown, label: string): "all" | { rules?: string[]; cells?: string[] } {
  if (scope === "all") return "all";
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw new AgreelyConfigError(`${label}: scope must be "all" or { rules?: string[], cells?: string[] }.`);
  }
  const { rules, cells } = scope as { rules?: unknown; cells?: unknown };
  const lists: { rules?: string[]; cells?: string[] } = {};
  for (const [key, value] of [["rules", rules], ["cells", cells]] as const) {
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new AgreelyConfigError(`${label}: scope.${key} must be a list of keys.`);
    }
    lists[key] = value as string[];
  }
  if ((lists.rules?.length ?? 0) === 0 && (lists.cells?.length ?? 0) === 0) {
    throw new AgreelyConfigError(`${label}: scope must list at least one rule or cell, or be "all".`);
  }
  return lists;
}
