import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { CustomerRecord, UpsertCustomerInput, UpsertCustomerResult } from "../types.js";
import { requireCustomerRef } from "../util.js";

/** The members `upsert` sends, and no others. */
const UPSERT_MEMBERS = ["displayName", "email", "basisNote", "legalBasis", "noticeLocale"] as const;

/**
 * The customer registry (scope 'registry'): the identity your own system holds for one
 * of its customers, recorded where the accountability record lives. Keyed on YOUR
 * customerRef (the one /v1/check uses), never a DID.
 *
 * THERE IS NO LIST, AND THE READ IS METADATA. Every route takes one customerRef you
 * already know, and `get` answers WHETHER a name, an address or a note is held, never
 * what it says: Agreely is not a place to read your customers back from.
 *
 * The per-customer retention clock, dispositions and holds live on `agreely.retention`
 * (same scope).
 */
export class Customers {
  constructor(private readonly transport: Transport) {}

  /**
   * What Agreely holds for one customerRef, as metadata, with the relationship's
   * lifecycle. A ref this company never touched is AgreelyNotFoundError (another
   * tenant's ref reads the same). A read; safe to auto-retry on a transient outage.
   */
  get(customerRef: string): Promise<CustomerRecord> {
    const ref = requireCustomerRef(customerRef, "customers.get");
    return this.transport.request<CustomerRecord>({
      method: "GET",
      path: `/v1/customers/${encodeURIComponent(ref)}`,
      idempotentRetry: true,
    });
  }

  /**
   * Record or amend the registry identity of one customer (PUT /v1/customers/{ref}).
   *
   * A MERGE, NEVER A REPLACE: a member you leave out is untouched, `null` or `""` CLEARS
   * it, a value writes it. A full replace would let a sync that only knows addresses
   * wipe a name curated in Agreely. `created` is true when this call created the record
   * (HTTP 201), false when it merged into an existing one (200).
   *
   * `legalBasis` must be a non-consent ground of YOUR act (a consent-held client belongs
   * to the consent flow); anything else is a 422 naming it, never dropped silently. No
   * consent side effect: no email, no request, no enforcement record.
   *
   * A 409 AgreelyConflictError carries its stable string in `code` (no `reason` on this
   * route): `identity_erased` (a standing destruction or anonymization removed the
   * identity; a value would undo that, a clear still works) or `identity_held` (a hold on
   * all the information keeps it as is; nothing may change, a clear included).
   *
   * Refused client-side: a blank or over-200-character customerRef, a member that is not
   * a string or null. Never auto-retried.
   */
  async upsert(customerRef: string, input: UpsertCustomerInput): Promise<UpsertCustomerResult> {
    const label = "customers.upsert";
    const ref = requireCustomerRef(customerRef, label);
    const body: Record<string, string | null> = {};
    for (const member of UPSERT_MEMBERS) {
      const value: unknown = input[member];
      if (value === undefined) continue; // absent = untouched (the merge contract)
      if (value !== null && typeof value !== "string") {
        throw new AgreelyConfigError(`${label}: ${member} must be a string, or null to clear it.`);
      }
      body[member] = value;
    }
    const { status, body: record } = await this.transport.requestWithStatus<CustomerRecord>({
      method: "PUT",
      path: `/v1/customers/${encodeURIComponent(ref)}`,
      body,
      idempotentRetry: false,
    });
    return { ...record, created: status === 201 };
  }
}
