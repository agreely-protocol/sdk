import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { ConsentWithdrawal, IdempotencyOptions, RecordWithdrawalInput, WithdrawalChannel } from "../types.js";
import { assertInput, assertOptions, recordIdempotencyKey, requireCustomerRef, toWireInstant } from "../util.js";

/** The channels a person may have used to ask, as the server knows them. */
export const WITHDRAWAL_CHANNELS: readonly WithdrawalChannel[] = ["phone", "email", "mail", "in_person", "other"];

/** An opaque staff identifier: neither an email address nor free prose fits. */
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A protocol consentRef: 32 bytes of hex, with or without its 0x prefix. */
const CONSENT_REF = /^(?:0[xX])?[0-9a-fA-F]{64}$/;

/** At most this many characters of reason, mirrored from the server. */
export const WITHDRAWAL_REASON_MAX = 1000;

/** At most this many consentRefs in `alsoWithdraw`, mirrored from the server. */
export const WITHDRAWAL_SCOPE_MAX = 50;

/** The members a withdrawal input may carry: anything else is refused, never dropped. */
const WITHDRAWAL_INPUT_MEMBERS = ["channel", "operator", "requestedAt", "reason", "otherConsents", "alsoWithdraw"];

/**
 * The scope a withdrawal declares toward the OTHER consents of its purpose, checked before any call: one
 * declaration at most, and the server answers 422 `other_consents_running` when another consent is in force
 * and none is declared.
 */
function withdrawalScope(
  input: RecordWithdrawalInput,
  label: string,
): { otherConsents?: "withdraw" | "keep"; alsoWithdraw?: string[] } {
  const { otherConsents, alsoWithdraw } = input;
  if (otherConsents !== undefined && alsoWithdraw !== undefined) {
    throw new AgreelyConfigError(`${label}: declare the scope once: otherConsents or alsoWithdraw, never both.`);
  }
  if (otherConsents !== undefined) {
    if (otherConsents !== "withdraw" && otherConsents !== "keep") {
      throw new AgreelyConfigError(`${label}: otherConsents must be "withdraw" or "keep".`);
    }
    return { otherConsents };
  }
  if (alsoWithdraw !== undefined) {
    if (!Array.isArray(alsoWithdraw) || alsoWithdraw.length > WITHDRAWAL_SCOPE_MAX) {
      throw new AgreelyConfigError(`${label}: alsoWithdraw must be a list of at most ${WITHDRAWAL_SCOPE_MAX} consentRefs.`);
    }
    const refs = alsoWithdraw.map((ref: unknown) => (typeof ref === "string" ? ref.trim() : ""));
    if (!refs.every((ref) => CONSENT_REF.test(ref))) {
      throw new AgreelyConfigError(`${label}: every alsoWithdraw entry must be a 0x-prefixed 64-hex consentRef.`);
    }
    return { alsoWithdraw: refs };
  }
  return {};
}

/**
 * Withdrawals recorded on the person's behalf (scope 'withdraw'): the organisation
 * records the withdrawal a person asked it for, by any channel, of ANY consent ask it
 * holds for her, a consent she signed online with her passkey included. /v1/check
 * denies at once.
 *
 * HONEST BY CONSTRUCTION: every answer says `recordedOnBehalf: true` and
 * `assurance: "company_documented"`. Agreely records that the organisation says it
 * received and actioned the request; it never presents it as her own signed revocation.
 *
 * THE SCOPE IS ITS OWN GRANT, never given by default: a key holding it can switch off
 * every consent of the company one call at a time. A per-company daily cap applies (429
 * AgreelyDailyCapError, code `withdrawal_daily_cap`, no Retry-After) and the owner is
 * notified. It is the one /v1 route that still answers while the company's billing has
 * lapsed: honouring a withdrawal is a legal duty, not a paid service.
 */
export class Withdrawals {
  constructor(private readonly transport: Transport) {}

  /**
   * Record that the person withdrew the consent `consentRef` held for `customerRef`
   * (POST /v1/customers/{customerRef}/consents/{consentRef}/withdrawal).
   *
   * A withdrawal attaches to the PURPOSE, but the other running consents of the same purpose
   * (a renewal and the paper it renewed, a verbal consent and its paper, or a second person's
   * consent) are withdrawn with it ONLY WHEN YOU SAY SO: `otherConsents: "withdraw"` takes
   * them all, `alsoWithdraw` names them, `otherConsents: "keep"` withdraws this consent alone.
   * Those carried at the same instant are listed in `alsoWithdrawn`; the others still in force
   * are listed in `stillInForce`. Read `gate` for what /v1/check does now. Accepted after the
   * relationship ended: the right to withdraw outlives it.
   *
   * Refused client-side (AgreelyConfigError, before any call): a blank customerRef, a
   * consentRef that is not 32 bytes of hex, a channel outside phone | email | mail |
   * in_person | other, an operator that is not an opaque identifier (an email address is
   * refused), a requestedAt without an offset, a reason over 1000 characters, an
   * `otherConsents` other than "withdraw" | "keep", an `alsoWithdraw` over 50 entries or with
   * one that is not a consentRef, both `otherConsents` and `alsoWithdraw` together, and any
   * member the input does not name.
   *
   * Refused by the server (compare `error.reason`): 404 `unknown_consent` (an unknown,
   * foreign or other customer's reference: the same answer, byte for byte); 409
   * `consent_lapsed` (the consent ended on its own date: check the purpose, another
   * consent may be in force); 422 `not_revocable` (the cell was never a consent ask),
   * `requested_at_in_future`, `requested_at_before_grant`, `not_running_for_purpose` (an
   * `alsoWithdraw` entry is not another consent in force for the purpose); 422
   * `other_consents_running` when another consent of the purpose is in force and the call
   * declared no scope (`AgreelyOtherConsentsRunningError`, `error.otherConsentRefs`: ask the
   * person, then retry with a scope); 429 `daily_cap`.
   *
   * NEVER auto-retried. An Idempotency-Key is auto-generated per call (overridable): a
   * retry with the same key and body replays the first answer (a 200) and writes nothing.
   * Invalid input rejects the returned promise; nothing is thrown synchronously.
   */
  async record(
    customerRef: string,
    consentRef: string,
    input: RecordWithdrawalInput,
    options: IdempotencyOptions = {},
  ): Promise<ConsentWithdrawal> {
    const label = "withdrawals.record";
    assertOptions(options, ["idempotencyKey"], label);
    assertInput(input, WITHDRAWAL_INPUT_MEMBERS, label);
    const ref = requireCustomerRef(customerRef, label);
    const consent = typeof consentRef === "string" ? consentRef.trim() : "";
    if (!CONSENT_REF.test(consent)) {
      throw new AgreelyConfigError(`${label}: consentRef must be the 0x-prefixed 64-hex consentRef.`);
    }
    const channel: unknown = input.channel;
    if (typeof channel !== "string" || !(WITHDRAWAL_CHANNELS as readonly string[]).includes(channel)) {
      throw new AgreelyConfigError(`${label}: channel must be one of ${WITHDRAWAL_CHANNELS.join(", ")}.`);
    }
    const operator = typeof input.operator === "string" ? input.operator.trim() : "";
    if (!OPERATOR.test(operator)) {
      throw new AgreelyConfigError(
        `${label}: operator is your opaque identifier of the staff member who received the request: 1 to 64 ` +
          `letters, digits, dots, underscores, colons or hyphens. Never an email address.`,
      );
    }
    const reason: unknown = input.reason;
    if (reason !== undefined && (typeof reason !== "string" || [...reason].length > WITHDRAWAL_REASON_MAX)) {
      throw new AgreelyConfigError(`${label}: reason must be a string of at most ${WITHDRAWAL_REASON_MAX} characters.`);
    }
    const scope = withdrawalScope(input, label);
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, label);
    return this.transport.request<ConsentWithdrawal>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(ref)}/consents/${encodeURIComponent(consent)}/withdrawal`,
      // The body carries the named fields and the scope only, so nothing else on your object leaves the process.
      body: {
        channel,
        operator,
        ...(input.requestedAt !== undefined
          ? { requestedAt: toWireInstant(input.requestedAt, `${label}: requestedAt`).wire }
          : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...scope,
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }
}
