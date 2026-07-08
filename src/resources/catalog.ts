import type { Transport } from "../transport.js";
import type { CatalogEntry } from "../types.js";

interface CatalogWire {
  catalog: CatalogEntry[];
}

/**
 * The catalog resource (scope: 'check' OR 'issue') — read-only discovery of the
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
}
