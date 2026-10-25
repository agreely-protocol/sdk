// Shared by the anchor tests: the readable Base Sepolia registry, a bundle re-pointed at it, and the eth_call
// answers of registry(bytes32) and rootOf(bytes32).

/** The AgreelyRegistry the SDK reads by default on Base Sepolia (84532), EIP-55 checksummed. */
export const SEPOLIA_REGISTRY = "0xf25D3F8E73648C797Be2CCCD428061f357567b9A";

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
