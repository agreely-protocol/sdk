import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely, AgreelyConfigError } from "../../src/index.js";
import type { CreateConsentRequestInput } from "../../src/types.js";
import { mockFetch } from "./helpers.js";

/**
 * ISSUANCE-envelope golden vectors (shared with the PHP suite via
 * vectors/vectors.json): consentRequests.create must send EXACTLY one of
 * consentDocumentId / documentCode, never a caller-supplied `items` list, and
 * fail client-side (config error, nothing sent) on zero or two references.
 */
interface IssuanceCase {
  name: string;
  use: string[];
  includeItems: boolean;
  expect: {
    method?: string;
    path?: string;
    body?: Record<string, unknown>;
    error?: string;
  };
}

interface IssuanceVectors {
  base: Record<string, string>;
  consentDocumentId: string;
  documentCode: string;
  rejectedItems: unknown[];
  cases: IssuanceCase[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/vectors.json", import.meta.url)), "utf8"),
) as { issuanceRequest: IssuanceVectors };

const golden = vectors.issuanceRequest;

const issued = {
  requestId: "0x" + "ab".repeat(32),
  status: "pending",
  deepLink: "https://x",
  emailDelivered: true,
  items: [],
  document: null,
};

function buildInput(c: IssuanceCase): CreateConsentRequestInput {
  const input: Record<string, unknown> = { ...golden.base };
  if (c.use.includes("consentDocumentId")) input.consentDocumentId = golden.consentDocumentId;
  if (c.use.includes("documentCode")) input.documentCode = golden.documentCode;
  // The wire envelope must DROP a caller-supplied items list (items derive
  // from the document server-side).
  if (c.includeItems) input.items = golden.rejectedItems;
  return input as unknown as CreateConsentRequestInput;
}

describe("issuanceRequest golden vectors (shared with the PHP SDK)", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { fetch, calls } = mockFetch([{ status: 201, json: issued }]);
      const agreely = new Agreely({ apiKey: "agr_live_test", timeout: 5000, fetch });

      if (c.expect.error === "config") {
        await expect(async () => agreely.consentRequests.create(buildInput(c))).rejects.toBeInstanceOf(
          AgreelyConfigError,
        );
        expect(calls.length).toBe(0); // failed client-side, nothing was sent
        return;
      }

      await agreely.consentRequests.create(buildInput(c));
      expect(calls.length).toBe(1);
      const call = calls[0]!;
      expect(call.method).toBe(c.expect.method);
      expect(new URL(call.url).pathname).toBe(c.expect.path);
      // EXACT envelope: the body deep-equals the golden body — no items key,
      // no second document reference, nothing extra.
      expect(call.body).toEqual(c.expect.body);
      expect(call.headers["idempotency-key"] ?? call.headers["Idempotency-Key"]).toBeTruthy();
    });
  }
});
