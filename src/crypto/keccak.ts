// A compact, dependency-free keccak-256 (the Ethereum hash, NOT NIST SHA3-256;
// the difference is the domain-separation padding byte 0x01 vs 0x06). Used to
// derive the AgreelyRegistry event topic and selector, the keccak256(utf8(cid))
// document commitment, and the recomputed passkey challenge of a bundle. Matches the app's
// kornrunner/Keccak output. Verified against keccak256("") =
// c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK = (1n << 64n) - 1n;

function rotl(x: bigint, n: number): bigint {
  const nn = BigInt(n);
  return ((x << nn) | (x >> (64n - nn))) & MASK;
}

function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
    }
    for (let i = 0; i < 25; i++) state[i] = state[i]! ^ d[i % 5]!;

    // Rho + Pi
    let t = state[1]!;
    for (let i = 0; i < 24; i++) {
      const j = PILN[i]!;
      const tmp = state[j]!;
      state[j] = rotl(t, ROTC[i]!);
      t = tmp;
    }

    // Chi
    for (let y = 0; y < 25; y += 5) {
      const row = [state[y]!, state[y + 1]!, state[y + 2]!, state[y + 3]!, state[y + 4]!];
      for (let x = 0; x < 5; x++) {
        state[y + x] = row[x]! ^ ((row[(x + 1) % 5]! ^ MASK) & row[(x + 2) % 5]!);
      }
    }

    // Iota
    state[0] = state[0]! ^ RC[round]!;
  }
}

/** keccak-256 of the input bytes, returning a 32-byte digest. */
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136; // 1088 bits for keccak-256
  const state = new Array<bigint>(25).fill(0n);

  // Absorb with keccak (0x01) padding.
  const padded = padKeccak(input, rate);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[offset + i * 8 + b]!) << BigInt(8 * b);
      }
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }

  // Squeeze 32 bytes.
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function padKeccak(input: Uint8Array, rate: number): Uint8Array {
  const padLen = rate - (input.length % rate);
  const out = new Uint8Array(input.length + padLen);
  out.set(input, 0);
  out[input.length] = out[input.length]! ^ 0x01; // keccak domain byte
  out[out.length - 1] = out[out.length - 1]! ^ 0x80;
  return out;
}

/** keccak-256 of a UTF-8 string, as a 0x-hex digest. */
export function keccak256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return "0x" + Buffer.from(keccak256(bytes)).toString("hex");
}
