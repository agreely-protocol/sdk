import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { ConsentWithdrawal, IdempotencyOptions, RecordWithdrawalInput, WithdrawalChannel } from "../types.js";
import { assertOptions, recordIdempotencyKey, requireCustomerRef, toWireInstant } from "../util.js";

/** The channels a person may have used to ask, as the server knows them. */
export const WITHDRAWAL_CHANNELS: readonly WithdrawalChannel[] = ["phone", "email", "mail", "in_person", "other"];

/** An opaque staff identifier: neither an email address nor free prose fits. */
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A protocol consentRef: 32 bytes of hex, with or without its 0x prefix. */
const CONSENT_REF = /^(?:0[xX])?[0-9a-fA-F]{64}$/;

/** At most this many characters of reason, mirrored from the server. */
export const WITHDRAWAL_REASON_MAX = 1000;

/**
 * Withdrawals recorded on the person's behalf (scope 'withdraw'): the organisation
 * records the withdrawal a person asked it for, by any channel, of ANY consent ask it
 * holds for her, a consent she signed online with her passkey included. /v1/check
 * denies at once.
 *
 * HONEST BY CONSTRUCTION: every answer says `recordedOnBehalf: true` and
 * `assurance: "company_attested"`. Agreely records that the organisation says it
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
   * A withdrawal attaches to the PURPOSE: the other running consents of the same purpose
   * in the chain (a renewal and the paper it renewed, a verbal consent and its paper) are
   * withdrawn at the same instant and listed in `alsoWithdrawn`. Read `gate` for what
   * /v1/check does now. Accepted after the relationship ended: the right to withdraw
   * outlives it.
   *
   * Refused client-side (AgreelyConfigError, before any call): a blank customerRef, a
   * consentRef that is not 32 bytes of hex, a channel outside phone | email | mail |
   * in_person | other, an operator that is not an opaque identifier (an email address is
   * refused), a requestedAt without an offset, a reason over 1000 characters.
   *
   * Refused by the server (compare `error.reason`): 404 `unknown_consent` (an unknown,
   * foreign or other customer's reference: the same answer, byte for byte); 409
   * `consent_lapsed` (the consent ended on its own date: check the purpose, another
   * consent may be in force); 422 `not_revocable` (the cell was never a consent ask),
   * `requested_at_in_future`, `requested_at_before_grant`; 429 `daily_cap`.
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
    const idempotencyKey = recordIdempotencyKey(options.idempotencyKey, label);
    return this.transport.request<ConsentWithdrawal>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(ref)}/consents/${encodeURIComponent(consent)}/withdrawal`,
      // The body carries the four named fields only, so nothing else on your object leaves the process.
      body: {
        channel,
        operator,
        ...(input.requestedAt !== undefined
          ? { requestedAt: toWireInstant(input.requestedAt, `${label}: requestedAt`).wire }
          : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey },
      idempotentRetry: false,
    });
  }
}
