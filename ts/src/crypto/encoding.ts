// Encoding seams shared by the offline receipt verifier: base58btc + multibase
// (a byte-for-byte port of the app's App\Models\Crypto\Multibase), base64url, and
// hex. base58btc is implemented here so the SDK stays dependency-light and the
// decode matches the encoder the DID document / proofValue were produced with.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_PUB_MULTICODEC = Uint8Array.from([0xed, 0x01]);

/** Decode a base58btc string to bytes. Throws on an invalid character. */
export function base58btcDecode(input: string): Uint8Array {
  const map = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) map.set(BASE58_ALPHABET[i]!, i);

  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;

  const bytes: number[] = [0];
  for (const ch of input) {
    const carryStart = map.get(ch);
    if (carryStart === undefined) {
      throw new EncodingError(`Multibase: invalid base58btc character "${ch}".`);
    }
    let carry = carryStart;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  // leading zeros already zero-filled; append reversed digits after them
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/** Decode a `z…` multibase string (base58btc) to its raw bytes. */
export function multibaseDecode(multibase: string): Uint8Array {
  if (multibase === "" || multibase[0] !== "z") {
    throw new EncodingError("Multibase: expected a z-base58btc multibase string.");
  }
  return base58btcDecode(multibase.slice(1));
}

/** Decode a publicKeyMultibase (`z…`) to the raw 32-byte Ed25519 key. */
export function decodeEd25519PublicKeyMultibase(multibase: string): Uint8Array {
  const bytes = multibaseDecode(multibase);
  if (
    bytes.length < 2 ||
    bytes[0] !== ED25519_PUB_MULTICODEC[0] ||
    bytes[1] !== ED25519_PUB_MULTICODEC[1]
  ) {
    throw new EncodingError("Multibase: not an ed25519-pub multicodec key.");
  }
  const raw = bytes.slice(2);
  if (raw.length !== 32) {
    throw new EncodingError("Multibase: decoded Ed25519 key is not 32 bytes.");
  }
  return raw;
}

/** Decode a base64url string (no padding required) to bytes. */
export function base64urlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

/** Encode bytes to a base64url string (no padding). */
export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode a hex string (optionally 0x-prefixed) to bytes. */
export function hexDecode(input: string): Uint8Array {
  const hex = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new EncodingError(`Invalid hex string "${input}".`);
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Encode bytes to a lowercase hex string with a 0x prefix. */
export function hexEncode(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

/** Constant-time-ish byte equality (length-checked). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingError";
  }
}
