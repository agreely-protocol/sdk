import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyConfigError,
  AgreelyNotFoundError,
  AgreelyValidationError,
  INVENTORY_MAX_SETS,
  type ReplaceInventoryInput,
} from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";

function client(script: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch }), calls };
}

const declaration: ReplaceInventoryInput = {
  hostSystem: "crm",
  categories: [
    {
      key: "benevoles",
      label: "Bénévoles",
      labelEn: "Volunteers",
      fields: [
        { key: "nom", label: "Nom" },
        { key: "naissance", label: "Date de naissance", labelEn: "Date of birth" },
      ],
    },
  ],
};

describe("inventory.replaceCategories", () => {
  it("PUTs the complete list with only the documented members", async () => {
    const { agreely, calls } = client([{ json: { hostSystem: "crm", withdrawn: 1, categories: [] } }]);
    const withValue = {
      ...declaration,
      categories: [
        {
          ...declaration.categories[0]!,
          fields: [{ key: "nom", label: "Nom", value: "Jean Tremblay" }],
        },
      ],
    } as unknown as ReplaceInventoryInput;
    const r = await agreely.inventory.replaceCategories(withValue);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${BASE}/v1/inventory/categories`);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("Jean Tremblay");
    expect(r.withdrawn).toBe(1);
  });

  it("refuses an empty list before any wire call, never reading it as withdraw-everything", () => {
    const { agreely, calls } = client([{ json: {} }]);
    expect(() => agreely.inventory.replaceCategories({ hostSystem: "crm", categories: [] })).toThrow(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("refuses over 200 sets, a set without fields, and a pod name as hostSystem", () => {
    const { agreely, calls } = client([{ json: {} }]);
    const set = declaration.categories[0]!;
    expect(INVENTORY_MAX_SETS).toBe(200);
    expect(() =>
      agreely.inventory.replaceCategories({ hostSystem: "crm", categories: Array.from({ length: 201 }, () => set) }),
    ).toThrow(AgreelyConfigError);
    expect(() =>
      agreely.inventory.replaceCategories({ hostSystem: "crm", categories: [{ ...set, fields: [] }] }),
    ).toThrow(AgreelyConfigError);
    expect(() => agreely.inventory.replaceCategories({ ...declaration, hostSystem: "crm-5d8f9c7b6a" })).toThrow(
      AgreelyConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces a value-shaped label refusal with its code and path", async () => {
    const { agreely } = client([
      { status: 422, json: { error: { code: "value_shaped_label", message: "looks like a value", field: "categories[0].fields[0].label" } } },
    ]);
    const err = await agreely.inventory.replaceCategories(declaration).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgreelyValidationError);
    expect((err as AgreelyValidationError).code).toBe("value_shaped_label");
    expect((err as AgreelyValidationError).field).toBe("categories[0].fields[0].label");
  });

  it("maps a 413 body_too_large to a validation error, not an outage", async () => {
    const { agreely } = client([{ status: 413, json: { error: { code: "body_too_large", message: "too large" } } }]);
    await expect(agreely.inventory.replaceCategories(declaration)).rejects.toBeInstanceOf(AgreelyValidationError);
  });
});

describe("inventory reads", () => {
  it("lists the sets, optionally for one host system", async () => {
    const { agreely, calls } = client([{ json: { categories: [] } }]);
    await agreely.inventory.listCategories({ hostSystem: "crm" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/inventory/categories?hostSystem=crm`);
  });

  it("resolves one frozen statement by key", async () => {
    const { agreely, calls } = client([
      {
        json: {
          categoryKey: "benevoles",
          hostSystem: "crm",
          current: false,
          supersededAt: "2026-09-26T00:00:00.000000Z",
          key: "55555555-5555-4555-8555-555555555555",
          revision: 1,
          frozenAt: "2026-09-25T00:00:00.000000Z",
          decided: true,
          duration: { value: 3, unit: "months" },
          trigger: "collection",
          action: "destroy",
          text: { fr: "…", en: "…" },
        },
      },
    ]);
    const s = await agreely.inventory.getStatement("55555555-5555-4555-8555-555555555555");
    expect(calls[0]!.url).toBe(`${BASE}/v1/inventory/statements/55555555-5555-4555-8555-555555555555`);
    expect(s.current).toBe(false);
    expect(s.duration?.value).toBe(3);
  });

  it("maps an unknown statement to AgreelyNotFoundError", async () => {
    const { agreely } = client([{ status: 404, json: { error: { code: "not_found", message: "No retention statement with that key." } } }]);
    await expect(agreely.inventory.getStatement("nope")).rejects.toBeInstanceOf(AgreelyNotFoundError);
  });
});
