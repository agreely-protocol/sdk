// COMPILE-TIME refusals for the per-customer retention, the withdrawal and the error
// reason. Every @ts-expect-error below is a guard: `npm run typecheck` FAILS ("Unused
// '@ts-expect-error' directive") the day the line it sits on starts compiling.
import { describe, expect, it } from "vitest";
import type {
  AgreelyErrorReason,
  DeclareDispositionInput,
  PlaceHoldInput,
  RecordWithdrawalInput,
  Scope,
} from "../../src/index.js";

// @ts-expect-error an other_law hold must name the provision that requires keeping the information.
export const otherLawWithoutProvision: PlaceHoldInput = { ground: "other_law" };

// @ts-expect-error a rights_request hold takes no provision: the ground is the act itself.
export const rightsWithProvision: PlaceHoldInput = { ground: "rights_request", provision: "art. 36" };

// @ts-expect-error a ground outside the two does not exist.
export const unknownGround: PlaceHoldInput = { ground: "lawsuit" };

// @ts-expect-error a legal hold must name the law that imposes the delay.
export const legalHoldWithoutReason: DeclareDispositionInput = { disposition: "legal_hold" };

// @ts-expect-error a destroyed record has no remaining conservation horizon.
export const destroyedUntil: DeclareDispositionInput = { disposition: "destroyed", retentionUntil: "2030-01-01" };

// @ts-expect-error there is no "nothing applied" disposition: that is no entry.
export const nothingApplied: DeclareDispositionInput = { disposition: "none" };

// @ts-expect-error a withdrawal names how the person asked.
export const withoutChannel: RecordWithdrawalInput = { operator: "agent-042" };

// @ts-expect-error fax is not a channel the server knows.
export const faxChannel: RecordWithdrawalInput = { channel: "fax", operator: "agent-042" };

// Allowed shapes, so the guards above fail for the right reason.
export const otherLaw: PlaceHoldInput = { ground: "other_law", provision: "art. 35", scope: { cells: ["c1"] } };
export const legalHold: DeclareDispositionInput = { disposition: "legal_hold", reason: "law", retentionUntil: "2030-01-01" };
export const scopes: Scope[] = ["withdraw", "holds", "registry"];
export const knownReason: AgreelyErrorReason = "citizen_consent_at_gate";
export const futureReason: AgreelyErrorReason = "a_reason_this_version_does_not_know";

describe("registry and withdrawal compile-time guards", () => {
  it("are enforced by `npm run typecheck`, which includes this file", () => {
    expect(scopes).toContain("withdraw");
  });
});
