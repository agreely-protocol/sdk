import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  InventoryDeclaration,
  InventoryFieldInput,
  InventoryRecordSet,
  ListInventoryInput,
  ReplaceInventoryInput,
  ResolvedRetentionStatement,
} from "../types.js";
import { assertHostToken } from "../util.js";

/** At most this many record sets per host-system declaration, mirrored from the server. */
export const INVENTORY_MAX_SETS = 200;

/** At most this many fields per record set, mirrored from the server. */
export const INVENTORY_MAX_FIELDS = 60;

interface ListWire {
  categories: InventoryRecordSet[];
}

/**
 * The host inventory resource. A host system declares the record sets it holds
 * and the NAMES of their fields, never a value; Agreely links each set to a
 * catalogue cell and returns the retention statement the host stamps on a record
 * at collection. What a set says it holds is what the host DECLARED.
 *
 * Scopes differ per method: replaceCategories needs 'inventory'; listCategories
 * accepts 'inventory' or 'retention'; getStatement also accepts 'check', so a
 * public collection form can resolve a statement without holding a key that
 * writes.
 */
export class Inventory {
  constructor(private readonly transport: Transport) {}

  /**
   * REPLACE a host system's inventory with the COMPLETE list given
   * (PUT /v1/inventory/categories). This is not an append: every set this system
   * declared before that is missing from `categories` is WITHDRAWN (it stays
   * listed, marked withdrawn, and `withdrawn` counts it). Always send the whole
   * list, from one source of truth, per hostSystem.
   *
   * An empty list is refused (it would read as "withdraw everything", which a
   * serialisation bug must never do in one call). Also refused client-side: more
   * than 200 sets or 60 fields per set, a set without fields, and a malformed
   * hostSystem. A list introducing more new set keys than the company may add in 30
   * days is a 422 `new_set_limit` (a key declared before is always accepted). The body carries only the documented members (key, label,
   * labelEn, fields), so nothing else on your objects leaves the process. Never
   * auto-retried.
   */
  async replaceCategories(input: ReplaceInventoryInput): Promise<InventoryDeclaration> {
    const label = "inventory.replaceCategories";
    const hostSystem = assertHostToken(input.hostSystem, `${label}: hostSystem`);
    const categories: unknown = input.categories;
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new AgreelyConfigError(
        `${label}: categories must declare at least one record set. To stop declaring a set, send the ` +
          `complete list without it.`,
      );
    }
    if (categories.length > INVENTORY_MAX_SETS) {
      throw new AgreelyConfigError(`${label}: at most ${INVENTORY_MAX_SETS} record sets per host system.`);
    }
    const body = {
      hostSystem,
      categories: input.categories.map((set, i) => {
        const fields: unknown = set.fields;
        if (!Array.isArray(fields) || fields.length === 0 || fields.length > INVENTORY_MAX_FIELDS) {
          throw new AgreelyConfigError(
            `${label}: categories[${i}].fields must list 1 to ${INVENTORY_MAX_FIELDS} fields.`,
          );
        }
        return {
          key: set.key,
          label: set.label,
          ...(set.labelEn !== undefined ? { labelEn: set.labelEn } : {}),
          fields: set.fields.map(pickField),
        };
      }),
    };
    return this.transport.request<InventoryDeclaration>({
      method: "PUT",
      path: "/v1/inventory/categories",
      body,
      idempotentRetry: false,
    });
  }

  /**
   * The declared record sets (withdrawn ones included), each with the cell and
   * rule Agreely linked it to and its current retention statement. A set whose
   * `decision.state` is not "decided" has no duration: the host abstains.
   */
  async listCategories(input: ListInventoryInput = {}): Promise<InventoryRecordSet[]> {
    const hostSystem =
      input.hostSystem !== undefined
        ? assertHostToken(input.hostSystem, "inventory.listCategories: hostSystem")
        : undefined;
    const wire = await this.transport.request<ListWire>({
      method: "GET",
      path: "/v1/inventory/categories",
      query: { hostSystem },
      idempotentRetry: true,
    });
    return wire.categories;
  }

  /**
   * One FROZEN retention statement, by the key a host stamped on a record at
   * collection. It resolves for as long as the set exists, whatever became of the
   * rule since: `current` is false once a later statement superseded it, and the
   * terms are still the ones frozen. An unknown key is AgreelyNotFoundError.
   */
  async getStatement(statementKey: string): Promise<ResolvedRetentionStatement> {
    const key = typeof statementKey === "string" ? statementKey.trim() : "";
    if (key === "") throw new AgreelyConfigError("inventory.getStatement requires a statementKey.");
    return this.transport.request<ResolvedRetentionStatement>({
      method: "GET",
      path: `/v1/inventory/statements/${encodeURIComponent(key)}`,
      idempotentRetry: true,
    });
  }
}

function pickField(field: InventoryFieldInput): InventoryFieldInput {
  return {
    key: field.key,
    label: field.label,
    ...(field.labelEn !== undefined ? { labelEn: field.labelEn } : {}),
  };
}
