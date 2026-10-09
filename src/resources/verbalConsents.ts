import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  ConfirmVerbalPaperInput,
  RecordVerbalConsentInput,
  VerbalAnswer,
  VerbalConsentHistory,
  VerbalConsentResult,
  VerbalPaperResult,
} from "../types.js";
import { recordIdempotencyKey, toWireInstant } from "../util.js";
import type { ConsentRecordOptions } from "./manualConsents.js";

/** The consentId shape the routes accept. Anything else is a 404 server-side, so it is refused here. */
const CONSENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The verbal consent resource: a consent the person gave BY TELEPHONE,
 * documented by the organisation. The WEAKEST of three tiers (full > manual >
 * verbal): there is no document, so the proof is the organisation's word. Every
 * result names it tier "verbal" / assurance "company_documented", and /v1/check
 * returns the same tier, so YOUR system decides what a telephone consent may unlock.
 *
 * Scopes: `record` needs 'attest_verbal' (a separate grant, never given by default);
 * `confirmWithPaper` needs 'attest' (the paper mints a company-attested consent);
 * `get` accepts either. Withdraw with `manualConsents.revoke` (either scope; a
 * verbal-only key reaches verbal refs only) or, when the person asked for it, with
 * `withdrawals.record` (scope 'withdraw'); erase with `manualConsents.erase` ('attest'
 * only).
 */
export class VerbalConsents {
  constructor(private readonly transport: Transport) {}

  /**
   * Record a consent given by telephone. Every ask put on the call is answered
   * EXPLICITLY, "yes" or "no"; only the "yes" purposes become consents. The lines the
   * document gives for information are recorded by the server as acknowledged from the
   * script (answering one is a 422). NEVER auto-retried (it mutates); an
   * Idempotency-Key is auto-generated per call (overridable) so a retry with the same
   * key and body replays the original 201.
   *
   * RENEWAL BY TELEPHONE. A paper consent ending within 30 days may be renewed by a
   * verbal one with the same call: its `validUntil` may not be earlier than the paper's.
   * Confirm it on paper later with `confirmWithPaper`. A withdrawal through any reference
   * of the chain withdraws the running consent too.
   *
   * Refusals (compare `error.reason`): 422 for a notice-only document (`notice_only`), an
   * answer on an information line (`informed_line_answered`), a bad obtainedAt or
   * validUntil, an obtainedAt in the future by ANY amount (`obtained_at_in_future`: a host
   * clock running ahead is refused, never clamped); 409 (AgreelyConflictError, code
   * "conflict") when a purpose is held by a stronger consent outside the renewal window
   * (`stronger_consent_active`) or already covered (`all_covered`), a renewal ends before
   * the consent it renews (`renewal_ends_before_current`) or predates its signature
   * (`renewal_predates_current`), the call predates a withdrawal (`predates_withdrawal`),
   * or the relationship has ended (`relationship_ended`); 429 AgreelyVerbalDailyCapError
   * (reason `daily_cap`) at the per-company daily cap.
   */
  record(input: RecordVerbalConsentInput, options: ConsentRecordOptions = {}): Promise<VerbalConsentResult> {
    const label = "verbalConsents.record";
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, label);
    const respondent = input.respondent;
    return this.transport.request<VerbalConsentResult>({
      method: "POST",
      path: "/v1/verbal-consents",
      body: {
        customerId: input.customerId,
        documentVersionId: input.documentVersionId,
        answers: wireAnswers(input.answers, label),
        obtainedAt: toWireInstant(input.obtainedAt, `${label}: obtainedAt`).wire,
        obtainedBy: input.obtainedBy,
        scriptVersion: input.scriptVersion,
        respondent: {
          consentedBy: respondent.consentedBy,
          ...(respondent.representativeCapacity !== undefined
            ? { representativeCapacity: respondent.representativeCapacity }
            : {}),
          ...(respondent.name !== undefined ? { name: respondent.name } : {}),
        },
        validUntil: input.validUntil instanceof Date ? toWireInstant(input.validUntil, `${label}: validUntil`).wire : input.validUntil,
        ...(input.sensitiveExpressAttested !== undefined ? { sensitiveExpressAttested: input.sensitiveExpressAttested } : {}),
        ...(input.isMinor !== undefined ? { isMinor: input.isMinor } : {}),
        ...(input.paperExpected !== undefined ? { paperExpected: input.paperExpected } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * The signed paper came back: the RISE to manual. The verbal consent is never
   * rewritten; each purpose ticked "yes" moves into a NEW manual consent (dated from
   * the call, with the signature as its evidence date) and the gate re-points at it.
   * A "no" is recorded as a withdrawal dated at `signedAt`. `answers` must cover
   * exactly the purposes still consented by telephone. One paper per verbal consent: a
   * second one is a 409 `already_confirmed`. A `signedAt` in the future by any amount is
   * a 422 `signed_at_in_future`. Scope 'attest'. NEVER auto-retried; idempotent like
   * `record`.
   */
  confirmWithPaper(
    consentId: string,
    input: ConfirmVerbalPaperInput,
    options: ConsentRecordOptions = {},
  ): Promise<VerbalPaperResult> {
    const label = "verbalConsents.confirmWithPaper";
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, label);
    return this.transport.request<VerbalPaperResult>({
      method: "POST",
      path: `/v1/verbal-consents/${assertConsentId(consentId, label)}/paper`,
      body: {
        signedAt: toWireInstant(input.signedAt, `${label}: signedAt`).wire,
        answers: wireAnswers(input.answers, label),
        evidence: {
          pdfSha256: input.evidence.pdfSha256,
          ...(input.evidence.pdf !== undefined ? { pdf: input.evidence.pdf } : {}),
        },
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }

  /**
   * The history of a verbal consent: what was said on the telephone, what the paper
   * said, and what is in force now. `state` is "awaiting_paper", "verbal_only" or
   * "paper_received". A missing, foreign or non-verbal id is an AgreelyNotFoundError.
   */
  get(consentId: string): Promise<VerbalConsentHistory> {
    return this.transport.request<VerbalConsentHistory>({
      method: "GET",
      path: `/v1/verbal-consents/${assertConsentId(consentId, "verbalConsents.get")}`,
      idempotentRetry: true,
    });
  }
}

function assertConsentId(consentId: unknown, label: string): string {
  if (typeof consentId !== "string" || !CONSENT_ID.test(consentId)) {
    throw new AgreelyConfigError(`${label} requires the consentId (a uuid) that verbalConsents.record returned.`);
  }
  return consentId.toLowerCase();
}

/**
 * The answers, as the wire wants them. An answer is exactly "yes" or "no": a boolean
 * or a missing answer is refused here, because a purpose is never consented by default.
 */
function wireAnswers(answers: VerbalAnswer[], label: string): VerbalAnswer[] {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new AgreelyConfigError(`${label} requires at least one answer.`);
  }
  return answers.map((a, i) => {
    if (a === null || typeof a !== "object" || (a.answer !== "yes" && a.answer !== "no")) {
      throw new AgreelyConfigError(`${label}: answers[${i}].answer must be exactly "yes" or "no".`);
    }
    return { category: a.category, purpose: a.purpose, answer: a.answer };
  });
}
