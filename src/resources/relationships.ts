import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  EndRelationshipInput,
  RelationshipEnded,
  RelationshipReverted,
  RevertRelationshipInput,
} from "../types.js";

/**
 * The customer-relationship lifecycle resource (scope: 'relationship'). Keyed on
 * the company's OWN customerRef (the same ref used by check), never a DID.
 */
export class Relationships {
  constructor(private readonly transport: Transport) {}

  /**
   * End a customer relationship (Law 25 art. 23, "les fins sont accomplies"),
   * the exact company-UI action, exposed for a company's own offboarding flow.
   * The `reason` is REQUIRED (the attestation must carry its justification): a
   * blank one fails CLOSED client-side (AgreelyConfigError) before any wire call,
   * never a silent end.
   *
   * IDEMPOTENT server-side: re-ending an already-ended relationship is a success
   * (the original endedAt + endedBy origin stand). An unknown or foreign
   * customerRef maps to AgreelyNotFoundError (404), with nothing written
   * server-side. Never auto-retried (it mutates).
   *
   * WHAT COUNTS AS A KNOWN CUSTOMER (this surprises people). The 404 gate asks whether
   * the ref has any consent HISTORY with your company: an enforcement record, a consent
   * request, or a recorded refusal. It does NOT ask whether `check` answers for the ref.
   * So a customer you only ever served on DECLARED NECESSITY cells (check returns allow
   * with status "necessity", which creates nothing) has no history, and `end` throws
   * AgreelyNotFoundError for them even though `check` just allowed. That is not a bug to
   * work around: there is no consent relationship to end, and the necessity allow is
   * governed by your catalog declaration, not by a per-subject record. If you need an
   * art. 23 stop to bite for such a customer, give them a real record first (a consent
   * request or a company-attested consent), or retire the catalog cell itself.
   *
   * Treat AgreelyNotFoundError here as "nothing to end", not as a failure, unless you
   * know the ref has consent history.
   */
  end(input: EndRelationshipInput): Promise<RelationshipEnded> {
    const customerRef = typeof input.customerRef === "string" ? input.customerRef.trim() : "";
    if (customerRef === "") {
      throw new AgreelyConfigError("relationships.end requires a customerRef.");
    }
    const reason = typeof input.reason === "string" ? input.reason : "";
    if (reason.trim() === "") {
      throw new AgreelyConfigError(
        "relationships.end requires a reason: the end of the relationship must carry its justification (art. 23).",
      );
    }
    return this.transport.request<RelationshipEnded>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(customerRef)}/relationship/end`,
      body: { reason },
      idempotentRetry: false,
    });
  }

  /**
   * UNDO a mistaken company-attested end (Law 25 art. 11 / art. 28 correction of
   * an inaccurate record), NOT a resurrection of dead consent. Allowed ONLY as a
   * narrow server-side carve-out: the end was company-attested, nothing was
   * destroyed, and it is within the correction window. On success the relationship
   * returns to 'active' and the still-active consents apply again.
   *
   * The `reason` is REQUIRED (the correction must carry its justification): a blank
   * one fails CLOSED client-side (AgreelyConfigError) before any wire call. A
   * relationship that is NOT undo-eligible maps to AgreelyNotFoundError (404), with
   * nothing written server-side. Never auto-retried (it mutates).
   */
  revert(input: RevertRelationshipInput): Promise<RelationshipReverted> {
    const customerRef = typeof input.customerRef === "string" ? input.customerRef.trim() : "";
    if (customerRef === "") {
      throw new AgreelyConfigError("relationships.revert requires a customerRef.");
    }
    const reason = typeof input.reason === "string" ? input.reason : "";
    if (reason.trim() === "") {
      throw new AgreelyConfigError(
        "relationships.revert requires a reason: the correction of a mistaken end must carry its justification (art. 11 / art. 28).",
      );
    }
    return this.transport.request<RelationshipReverted>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(customerRef)}/relationship/revert`,
      body: { reason },
      idempotentRetry: false,
    });
  }
}
