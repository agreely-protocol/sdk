import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { CatalogCells, CatalogEntry, DocumentCatalog } from "../types.js";

interface CatalogWire {
  catalog: CatalogEntry[];
}

/**
 * The catalog resource (scope: 'check' OR 'issue'), read-only discovery of the
 * company's declared active (category, purpose) entries, for composing issuance.
 */
export class Catalog {
  constructor(private readonly transport: Transport) {}

  /** The company's active declared catalog. */
  async list(): Promise<CatalogEntry[]> {
    const wire = await this.transport.request<CatalogWire>({
      method: "GET",
      path: "/v1/catalog",
      idempotentRetry: true,
    });
    return wire.catalog;
  }

  /**
   * The ACTIVE cells of ONE published consent document (GET /v1/catalog?documentCode=),
   * with the tenant's regime and the `documentVersionId` published today: one call
   * builds an intake form for that document AND names the version to record against.
   * Right for a single intake screen, where rendering the whole catalog would ask a
   * person about holdings the document never covers.
   *
   * The filter changes WHICH cells come back, never a field's value: `legalBasis` and
   * `sensitive` are the LIVE catalog declaration. Scope 'check' OR 'issue'. An unknown
   * code and another tenant's code are the same AgreelyNotFoundError; a blank one is
   * refused before the wire call. Never decide consent from it: a listed cell says
   * what was declared, only a check says what a person consented to.
   */
  forDocument(documentCode: string): Promise<DocumentCatalog> {
    const code = typeof documentCode === "string" ? documentCode.trim() : "";
    if (code === "") throw new AgreelyConfigError("catalog.forDocument requires a document code.");
    return this.transport.request<DocumentCatalog>({
      method: "GET",
      path: "/v1/catalog",
      query: { documentCode: code },
      idempotentRetry: true,
    });
  }

  /**
   * Every catalogue cell (archived ones included) with the retention rule that
   * governs it. Scope: 'retention', unlike {@link Catalog.list}. A cell whose
   * `retentionRuleKey` is null is a gap in the register: the host abstains from
   * purging under it and never picks a duration of its own.
   */
  listCells(): Promise<CatalogCells> {
    return this.transport.request<CatalogCells>({
      method: "GET",
      path: "/v1/catalog/cells",
      idempotentRetry: true,
    });
  }
}
