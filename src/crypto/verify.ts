// Signature verification primitives for the offline receipt verifier, built on
// node:crypto (the SDK targets Node 18+). Two suites:
//
//   - Ed25519 detached (the company `eddsa-jcs-2022` proof): verify a 64-byte
//     signature over the JCS-canonical body against the raw 32-byte public key
//     resolved from the company DID document's publicKeyMultibase.
//   - WebAuthn assertion (the citizen proof): parse the COSE public key resolved
//     from the citizen DID document (ES256 / EdDSA), and verify the assertion
//     signature over authenticatorData || sha256(clientDataJSON).

import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { base64urlEncode } from "./encoding.js";

/** Verify an Ed25519 detached signature over `message` with a raw 32-byte key. */
export function verifyEd25519(
  publicKeyRaw: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: base64urlEncode(publicKeyRaw) },
      format: "jwk",
    });
    return nodeVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** The parsed COSE key kinds the verifier supports. */
export type CoseAlg = "ES256" | "EdDSA" | "unsupported";

export interface CoseKey {
  alg: CoseAlg;
  /** For ES256: the P-256 x,y. For EdDSA: x only. */
  x: Uint8Array;
  y?: Uint8Array;
}

/**
 * Parse a COSE_Key (a small CBOR map) into the fields the verifier needs. Handles
 * exactly the shapes a WebAuthn passkey produces: EC2/P-256 (ES256) and
 * OKP/Ed25519 (EdDSA). RS256 and anything else resolve to `unsupported`.
 */
export function parseCoseKey(bytes: Uint8Array): CoseKey {
  const map = decodeCborMap(bytes);
  const kty = map.get(1);
  const alg = map.get(3);
  const x = map.get(-2);
  const y = map.get(-3);

  if (kty === 2 && alg === -7 && x instanceof Uint8Array && y instanceof Uint8Array) {
    return { alg: "ES256", x, y };
  }
  if (kty === 1 && alg === -8 && x instanceof Uint8Array) {
    return { alg: "EdDSA", x };
  }
  return { alg: "unsupported", x: x instanceof Uint8Array ? x : new Uint8Array() };
}

/**
 * Verify a WebAuthn assertion signature over authenticatorData || sha256(clientDataJSON).
 * ES256 signatures are DER-encoded ECDSA; EdDSA are raw 64-byte Ed25519.
 */
export function verifyWebAuthnAssertion(
  cose: CoseKey,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
): boolean {
  const clientHash = createHash("sha256").update(clientDataJSON).digest();
  const message = Buffer.concat([Buffer.from(authenticatorData), clientHash]);

  try {
    if (cose.alg === "ES256" && cose.y) {
      const key = createPublicKey({
        key: {
          kty: "EC",
          crv: "P-256",
          x: base64urlEncode(cose.x),
          y: base64urlEncode(cose.y),
        },
        format: "jwk",
      });
      return nodeVerify("sha256", message, { key, dsaEncoding: "der" }, signature);
    }
    if (cose.alg === "EdDSA") {
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: base64urlEncode(cose.x) },
        format: "jwk",
      });
      return nodeVerify(null, message, key, signature);
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// A minimal CBOR reader, just enough for a COSE_Key map: unsigned ints (major
// 0), negative ints (major 1), byte strings (major 2) and the map header (major
// 5). Anything else throws.
// ---------------------------------------------------------------------------

type CborValue = number | Uint8Array;

function decodeCborMap(bytes: Uint8Array): Map<number, CborValue> {
  const r = { buf: bytes, pos: 0 };
  const major = bytes[r.pos]! >> 5;
  if (major !== 5) throw new CborError("COSE key must be a CBOR map.");
  const n = readLength(r);
  const map = new Map<number, CborValue>();
  for (let i = 0; i < n; i++) {
    const key = readInt(r);
    const value = readValue(r);
    map.set(key, value);
  }
  return map;
}

interface Reader {
  buf: Uint8Array;
  pos: number;
}

function readLength(r: Reader): number {
  const info = r.buf[r.pos]! & 0x1f;
  r.pos++;
  if (info < 24) return info;
  if (info === 24) return r.buf[r.pos++]!;
  if (info === 25) {
    const v = (r.buf[r.pos]! << 8) | r.buf[r.pos + 1]!;
    r.pos += 2;
    return v;
  }
  throw new CborError("Unsupported CBOR length encoding in COSE key.");
}

function readInt(r: Reader): number {
  const major = r.buf[r.pos]! >> 5;
  const value = readLength(r);
  if (major === 0) return value;
  if (major === 1) return -1 - value;
  throw new CborError("Expected an integer CBOR key in COSE key.");
}

function readValue(r: Reader): CborValue {
  const major = r.buf[r.pos]! >> 5;
  if (major === 0) return readLength(r);
  if (major === 1) {
    const value = readLength(r);
    return -1 - value;
  }
  if (major === 2) {
    const len = readLength(r);
    const out = r.buf.slice(r.pos, r.pos + len);
    r.pos += len;
    return out;
  }
  throw new CborError("Unsupported CBOR value type in COSE key.");
}

class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}
