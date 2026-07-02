import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { EndRelationshipInput, RelationshipEnded } from "../types.js";

/**
 * The customer-relationship lifecycle resource (scope: 'relationship'). Keyed on
 * the company's OWN customerRef (the same ref used by check), never a DID.
 */
export class Relationships {
  constructor(private readonly transport: Transport) {}

  /**
   * End a customer relationship (Law 25 art. 23, "les fins sont accomplies") —
   * the exact company-UI action, exposed for a company's own offboarding flow.
   * The `reason` is REQUIRED (the attestation must carry its justification): a
   * blank one fails CLOSED client-side (AgreelyConfigError) before any wire call,
   * never a silent end.
   *
   * IDEMPOTENT server-side: re-ending an already-ended relationship is a success
   * (the original endedAt + endedBy origin stand). An unknown or foreign
   * customerRef maps to AgreelyNotFoundError (404), with nothing written
   * server-side. Never auto-retried (it mutates).
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
}
