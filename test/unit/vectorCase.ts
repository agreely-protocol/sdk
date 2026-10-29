import { expect } from "vitest";
import type { ReceiptVerification } from "../../src/verify/types.js";

// The expectation of a chain vector case (citizen-key-chain.json, recorded-v4.json, anchor-batch.json), read field by
// field: the keys the vector files name for what is not a plain result field.

/** The vector's expectation, field by field, against a result. */
export function expectFields(result: ReceiptVerification, want: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(want)) {
    if (key === "absent") {
      for (const field of value as string[]) expect(result).not.toHaveProperty(field);
    } else if (key === "companyKeyVerdict") {
      expect(result.companyKey?.verdict, key).toBe(value);
    } else if (key === "companyKeyRotated") {
      expect(result.companyKey?.rotated, key).toBe(value);
    } else if (key === "signedAnchorBinding") {
      expect(result.signedAnchor?.binding, key).toBe(value);
    } else if (key === "citizenKey") {
      expect(result.citizenKey, key).toMatchObject(value as object);
    } else if (key === "counts") {
      expect(result.consentAnchorCounts, key).toEqual(value);
    } else if (key !== "readRefs" && key !== "getLogsCalls" && key !== "tried") {
      expect((result as unknown as Record<string, unknown>)[key], key).toEqual(value);
    }
  }
}
