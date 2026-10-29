// Shared by the anchor and key tests: the readable Base Sepolia and Base mainnet registries, a bundle re-pointed at
// Sepolia, the eth_call answers of the registry reads, and a JSON-RPC endpoint answering each read by its selector.

/** The AgreelyRegistry the SDK reads by default on Base Sepolia (84532), EIP-55 checksummed. */
export const SEPOLIA_REGISTRY = "0xf25D3F8E73648C797Be2CCCD428061f357567b9A";

/** The AgreelyRegistry the SDK reads by default on Base mainnet (8453), EIP-55 checksummed. */
export const MAINNET_REGISTRY = "0x6F2cF94045cF0cbDD94338882c34D183575023E9";

/**
 * The bundle with its issuer delegation naming the readable Sepolia registry instead of the emit-only one the
 * vectors were issued on. The SDK does not verify that delegation, so no signature it checks moves; regenerated
 * bundles will make this unnecessary.
 */
export function onReadableRegistry<T>(bundle: T): T {
  const copy = structuredClone(bundle) as { didDocuments: { issuer: { delegation: { body: Record<string, unknown> } } } };
  copy.didDocuments.issuer.delegation.body["registry"] = SEPOLIA_REGISTRY.toLowerCase();
  copy.didDocuments.issuer.delegation.body["chainId"] = "84532";
  return copy as T;
}

const word = (n: number): string => n.toString(16).padStart(64, "0");

/** registry(bytes32): merkleRoot, anchoredAt, revokedAt, state, anchoredBlock. */
export function anchorWord(root: string, anchoredAt: number, revokedAt = 0, state = 1, anchoredBlock = anchoredAt === 0 ? 0 : 53000000): string {
  return "0x" + root.replace(/^0x/, "") + word(anchoredAt) + word(revokedAt) + word(state) + word(anchoredBlock);
}

/** rootOf(bytes32): tag, anchoredAt, anchoredBlock, lane. */
export function rootWord(lane: number, anchoredAt = 1790816400, anchoredBlock = 53000000, tag = 0): string {
  return "0x" + word(tag) + word(lane === 0 ? 0 : anchoredAt) + word(lane === 0 ? 0 : anchoredBlock) + word(lane);
}

/** keyOf(bytes32) and companyKeyOf(bytes32,bytes32): validFrom, anchoredAt, retiredAt, voidedAt. */
export function keyWord(validFrom: number, anchoredAt: number, retiredAt = 0, voidedAt = 0): string {
  return "0x" + word(validFrom) + word(anchoredAt) + word(retiredAt) + word(voidedAt);
}

/** A key window, valid and recorded from 2026-10-20, in force for every receipt in vectors/receipts. */
export const KEY_IN_FORCE = keyWord(1792500000, 1792500060);

/**
 * Consent anchor times a little after each bundle's grantedAt: an anchor earlier than grantedAt - SKEW would read
 * the consent as granted after its own anchor, and both keys with it.
 */
export const A1V1_ANCHORED_AT = 1792862400;
export const CIDV1_ANCHORED_AT = 1792545900;

/** A citizenKeySalt, a top-level member no signature covers, so a vector bundle can carry one. */
export function salted<T>(bundle: T): T {
  return { ...(structuredClone(bundle) as object), citizenKeySalt: "0x" + "5a".repeat(32) } as T;
}

export const ANCHOR_BATCH_TOPIC = "0x5254c3f989f0bd166934c5b72923f9347ff20239737b8787c1821858809de984";

/** The AnchorBatch(merkleRoot, refCount, timestamp) log the anchoring transaction emitted. */
export function anchorBatchLog(root: string, refCount: number, block = 53000000, address = SEPOLIA_REGISTRY.toLowerCase()) {
  return {
    address,
    topics: [ANCHOR_BATCH_TOPIC, "0x" + root.replace(/^0x/, "").toLowerCase()],
    data: "0x" + word(refCount) + word(0),
    blockNumber: "0x" + block.toString(16),
    removed: false,
  };
}

/** What a chain answers, read by read. A missing answer is a JSON-RPC error; a Response is sent as is; a throw is a network failure. */
export interface ChainAnswers {
  registry?: (consentRef: string) => unknown;
  rootOf?: (hash: string) => unknown;
  keyOf?: () => unknown;
  companyKeyOf?: () => unknown;
  getCompanyDid?: () => unknown;
  logs?: () => unknown;
}

const SELECTORS: Record<string, keyof ChainAnswers> = {
  "0x7ef50298": "registry",
  "0x6d6f398e": "rootOf",
  "0xdf78bce2": "keyOf",
  "0x25597a89": "companyKeyOf",
  "0x8181c629": "getCompanyDid",
};

/** A JSON-RPC endpoint answering each eth_call by its selector and eth_getLogs with `logs`. */
export function chainFetch(answers: ChainAnswers): {
  fetch: typeof fetch;
  calls: Array<{ method: string; params: unknown[] }>;
  refs: string[];
} {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const refs: string[] = [];
  const impl = (async (_input: string | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(req);
    let out: unknown;
    if (req.method === "eth_getLogs") {
      out = answers.logs?.();
    } else if (req.method === "eth_call") {
      const data = (req.params[0] as { data: string }).data;
      const read = SELECTORS[data.slice(0, 10)];
      const arg = "0x" + data.slice(10, 74);
      if (read === "registry") refs.push(arg);
      const answer = read === undefined ? undefined : answers[read];
      out = answer === undefined ? undefined : (answer as (a: string) => unknown)(arg);
    }
    if (out instanceof Response) return out;
    const body = out === undefined ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no answer" } } : { jsonrpc: "2.0", id: 1, result: out };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls, refs };
}

/** The `answers` of a vector case (citizen-key-chain.json, recorded-v4.json, anchor-batch.json). */
export interface VectorAnswers {
  registry?: Record<string, string>;
  keyOf?: string;
  companyKeyOf?: string;
  getCompanyDid?: string;
  anchorBatchLogs?: unknown[];
}

/** A chain answering by selector from a vector case's answers; an answer absent is a JSON-RPC error. */
export function vectorChainFetch(answers: VectorAnswers): ReturnType<typeof chainFetch> {
  const { registry, keyOf, companyKeyOf, getCompanyDid, anchorBatchLogs } = answers;
  return chainFetch({
    ...(registry !== undefined ? { registry: (ref: string) => registry[ref] } : {}),
    ...(keyOf !== undefined ? { keyOf: () => keyOf } : {}),
    ...(companyKeyOf !== undefined ? { companyKeyOf: () => companyKeyOf } : {}),
    ...(getCompanyDid !== undefined ? { getCompanyDid: () => getCompanyDid } : {}),
    ...(anchorBatchLogs !== undefined ? { logs: () => anchorBatchLogs } : {}),
  });
}
