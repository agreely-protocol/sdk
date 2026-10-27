import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { canonicalize } from "../../src/crypto/jcs.js";
import type { DidDocument } from "../../src/verify/types.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A throwaway company issuer: an Ed25519 key, its DID document, and an eddsa-jcs-2022 signer. */
export function testIssuer(issuer = "did:web:api.agreely.ca:c:acme") {
  const vm = `${issuer}#kms-1`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const didDoc = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: issuer,
    verificationMethod: [
      { id: vm, type: "Multikey", controller: issuer, publicKeyMultibase: "z" + base58(new Uint8Array([0xed, 0x01, ...rawPub])) },
    ],
    assertionMethod: [vm],
  } as unknown as DidDocument;
  return {
    issuer,
    vm,
    didDoc,
    resolver: (did: string): DidDocument | null => (did === issuer ? didDoc : null),
    /** The DataIntegrityProof over JCS(`body`). */
    proofOver(body: unknown): Record<string, unknown> {
      const sig = cryptoSign(null, Buffer.from(canonicalize(body), "utf8"), privateKey);
      return {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-jcs-2022",
        created: "2026-01-15T12:00:00Z",
        verificationMethod: vm,
        proofPurpose: "assertionMethod",
        proofValue: "z" + base58(new Uint8Array(sig)),
      };
    },
  };
}
