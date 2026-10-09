import type { Transport } from "../transport.js";
import type { CatalogCells, CatalogEntry } from "../types.js";

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
