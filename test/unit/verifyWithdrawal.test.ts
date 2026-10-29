import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import type { DidDocument, ReceiptVerification, VerifyReceiptOptions } from "../../src/verify/types.js";
import { KEY_IN_FORCE, anchorBatchLog, anchorWord, chainFetch, onReadableRegistry, salted } from "./registry.js";

function artefact(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../vectors/receipts/${name}.json`, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
}

const DID_DOCS = artefact("did-documents") as Record<string, DidDocument>;
const SEPOLIA = { rpcUrl: "https://rpc.test", chainId: 84532 };

async function verify(input: unknown, opts: VerifyReceiptOptions = {}): Promise<ReceiptVerification> {
  return Agreely.verifyReceipt(input, { resolver: (did) => DID_DOCS[did] ?? null, ...opts });
}

/**
 * Answers each registry(consentRef) with `byRef(ref)` (null is an HTTP 502), both keys in force, and, unless
 * `anchorLog` is false, the AnchorBatch log of the bundle's root naming 3 refs.
 */
function registry(byRef: (ref: string) => string | null, anchorLog = true): { fetch: typeof fetch; refs: string[] } {
  const rpc = chainFetch({
    registry: (ref) => byRef(ref) ?? new Response("down", { status: 502 }),
    keyOf: () => KEY_IN_FORCE,
    companyKeyOf: () => KEY_IN_FORCE,
    ...(anchorLog ? { logs: () => [anchorBatchLog(root(), 3)] } : {}),
  });
  return { fetch: rpc.fetch, refs: rpc.refs };
}

const bundle = (): Record<string, unknown> => salted(onReadableRegistry(artefact("a1v1.bundle")));
const root = (): string => String(bundle()["merkleRoot"]);
const refsOf = (b: Record<string, unknown>): string[] => b["consentRefs"] as string[];

describe("withdrawal: whether the consent is still in force, never folded into overall offline", () => {
  it("offline, a genuine bundle verifies and its withdrawal reads not_checked, never absent", async () => {
    const result = await verify(bundle());
    expect(result.overall).toBe("verified");
    expect(result.withdrawal).toBe("not_checked");
    expect(result).not.toHaveProperty("withdrawnAt");
  });

  it("every cell read in force under the bound root reads active, with no date", async () => {
    const rpc = registry(() => anchorWord(root(), 1792862400));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("pass");
    expect(result.withdrawal).toBe("active");
    expect(result).not.toHaveProperty("withdrawnAt");
  });

  it("a withdrawn cell reads withdrawn, dated at the latest withdrawal among the withdrawn cells", async () => {
    const [first, second] = refsOf(bundle());
    const rpc = registry((ref) =>
      ref === first ? anchorWord(root(), 1792862400, 1793000000, 2)
        : ref === second ? anchorWord(root(), 1792862400, 1793100000, 2)
          : anchorWord(root(), 1792862400),
    );
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.overall).toBe("withdrawn");
    expect(result.withdrawal).toBe("withdrawn");
    expect(result.withdrawnAt).toBe(1793100000);
  });

  it("a withdrawn record without its instant reads withdrawn, with no date rather than a made-up one", async () => {
    const rpc = registry(() => anchorWord(root(), 1792862400, 0, 2));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.withdrawal).toBe("withdrawn");
    expect(result).not.toHaveProperty("withdrawnAt");
  });

  it("an RPC that does not answer leaves the withdrawal not_checked", async () => {
    const rpc = registry(() => null);
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.withdrawal).toBe("not_checked");
  });

  it("a record under another root is a contradiction, never active", async () => {
    const rpc = registry(() => anchorWord("0x" + "99".repeat(32), 1792862400));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.overall).toBe("failed");
    expect(result.withdrawal).toBe("not_checked");
  });

  it("a paper receipt read with an rpcUrl leaves the withdrawal not_checked and reads no consent record", async () => {
    const rpc = registry(() => anchorWord(root(), 1792862400, 1793100000, 2));
    const result = await verify(artefact("a3v3.receipt"), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.overall).toBe("verified");
    expect(result.withdrawal).toBe("not_checked");
    expect(rpc.refs).toHaveLength(0);
    expect(result.notes.join("\n")).toContain("signs no anchor before version 4, so the withdrawal of this consent is not checked");
  });

  it("a bare passkey receipt and a malformed file leave the withdrawal not_checked", async () => {
    for (const input of [artefact("a1v1.receipt"), { version: "99" }, 42]) {
      expect((await verify(input, { ...SEPOLIA, fetch: registry(() => null).fetch })).withdrawal).toBe("not_checked");
    }
  });
});

describe("every accepted cell counts, whether or not the bundle names its ref", () => {
  it("a bundle that drops a withdrawn cell's ref is never read active", async () => {
    const full = bundle();
    const [kept1, kept2, dropped] = refsOf(full);
    const doctored = { ...full, consentRefs: [kept1, kept2] };
    const byRef = (ref: string) => (ref === dropped ? anchorWord(root(), 1792862400, 1793100000, 2) : anchorWord(root(), 1792862400));
    const rpc = registry(byRef, false);
    const result = await verify(doctored, { ...SEPOLIA, fetch: rpc.fetch });
    expect(rpc.refs).not.toContain(dropped);
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.consentAnchorCounts).toEqual({ cells: 3, active: 2, withdrawn: 0, pending: 0, unreadable: 1 });
    expect(result.withdrawal).toBe("not_checked");
    expect(result.notes.join("\n")).toContain("names a consentRef for 2 of the receipt's 3 accepted cells");
  });

  it("the anchor's own log counts the refs it wrote: an unnamed one is unreadable, never in force", async () => {
    const full = bundle();
    const [kept1, kept2, dropped] = refsOf(full);
    const doctored = { ...full, consentRefs: [kept1, kept2] };
    const rpc = registry((ref) => (ref === dropped ? anchorWord(root(), 1792862400, 1793100000, 2) : anchorWord(root(), 1792862400)));
    const result = await verify(doctored, { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.citizenAssertion).toBe("pass");
    expect(result.consentAnchor).toBe("unavailable");
    expect(result.consentAnchorCounts).toEqual({ cells: 3, active: 2, withdrawn: 0, pending: 0, unreadable: 1, anchorBatchRefs: 3 });
    expect(result.withdrawal).toBe("not_checked");
    expect(result.notes.join("\n")).toContain("The consent's anchor wrote 3 refs and the bundle names 2");
  });

  it("a genuine bundle naming every cell is read whole and reads active", async () => {
    const rpc = registry(() => anchorWord(root(), 1792862400));
    const result = await verify(bundle(), { ...SEPOLIA, fetch: rpc.fetch });
    expect(result.consentAnchorCounts).toEqual({ cells: 3, active: 3, withdrawn: 0, pending: 0, unreadable: 0, anchorBatchRefs: 3 });
    expect(rpc.refs).toHaveLength(3);
  });
});
