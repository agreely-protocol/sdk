// The IPFS copy of a consent document, fetched from a list of gateways that are trusted for nothing: a gateway's bytes
// count only once they re-encode to the CID (public/assets/verify/issuer.js cidV0OfFile, fetchFromGateway). Vector:
// vectors/ipfs-gateways.json.

import { createHash } from "node:crypto";
import { base58btcDecode } from "../crypto/encoding.js";

/**
 * The gateways asked when the caller names none, in order. Measured on 2026-10-29, server side, the file's bytes
 * re-encoded to its CID: only Lighthouse served them (ipfs.io, dweb.link, w3s.link and nftstorage.link answered 429,
 * gw3.io a parked-domain page, the others timed out or did not resolve).
 */
export const DEFAULT_IPFS_GATEWAYS: readonly string[] = Object.freeze(["https://gateway.lighthouse.storage/ipfs/"]);

/** The largest file `ipfs add` keeps in ONE block (the default 256 KiB chunk), so its CID can be recomputed. */
export const MAX_SINGLE_BLOCK_BYTES = 262144;

/** A gateway: a prefix to which the CID is appended, a template carrying `{cid}`, or a function of the CID. */
export type IpfsGateway = string | ((cid: string) => string);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CODEC_RAW = 0x55;
const CODEC_DAG_PB = 0x70;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** The dag-pb node `ipfs add` writes for a file of one block: its UnixFS File data is the whole file. */
function singleBlockNode(bytes: Uint8Array): Uint8Array {
  const size = varint(bytes.length);
  const unixfs = Uint8Array.from([0x08, 0x02, 0x12, ...size, ...bytes, 0x18, ...size]);
  return Uint8Array.from([0x0a, ...varint(unixfs.length), ...unixfs]);
}

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const i = BASE32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** The sha2-256 digest a CID names, and what it is the digest of; null when this verifier cannot recompute it. */
function cidTarget(cid: string): { digest: Uint8Array; of: "node" | "raw" } | null {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    let mh: Uint8Array;
    try {
      mh = base58btcDecode(cid);
    } catch {
      return null;
    }
    return mh.length === 34 && mh[0] === 0x12 && mh[1] === 0x20 ? { digest: mh.subarray(2), of: "node" } : null;
  }
  if (!cid.startsWith("b")) return null;
  const b = base32Decode(cid.slice(1));
  // version 1, a one-byte codec, then sha2-256 (0x12) over 32 bytes (0x20)
  if (b === null || b.length !== 36 || b[0] !== 0x01 || b[2] !== 0x12 || b[3] !== 0x20) return null;
  if (b[1] === CODEC_DAG_PB) return { digest: b.subarray(4), of: "node" };
  if (b[1] === CODEC_RAW) return { digest: b.subarray(4), of: "raw" };
  return null;
}

/** Can this verifier tell whether bytes are the file of `cid`? A CIDv0, or a base32 CIDv1 (raw or dag-pb) over sha2-256. */
export function cidIsComputable(cid: string): boolean {
  return cidTarget(cid) !== null;
}

/**
 * Do these bytes re-encode to `cid`? True or false for a computable CID; null when the CID is not one this verifier
 * can recompute. A dag-pb CID is recomputed for a file of at most one block.
 */
export function bytesMatchCid(cid: string, bytes: Uint8Array): boolean | null {
  const target = cidTarget(cid);
  if (target === null) return null;
  if (target.of === "node" && bytes.length > MAX_SINGLE_BLOCK_BYTES) return false;
  const digest = sha256(target.of === "node" ? singleBlockNode(bytes) : bytes);
  return Buffer.from(digest).equals(Buffer.from(target.digest));
}

export function gatewayUrl(gateway: IpfsGateway, cid: string): string {
  if (typeof gateway === "function") return gateway(cid);
  return gateway.includes("{cid}") ? gateway.replace("{cid}", cid) : gateway.replace(/\/+$/, "") + "/" + cid;
}

/** How a gateway is named in a note and in the result: as configured, or the origin of a function's URL. */
export function gatewayName(gateway: IpfsGateway, url: string): string {
  if (typeof gateway === "string") return gateway;
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The body, cut at MAX_SINGLE_BLOCK_BYTES as it arrives, so a hostile gateway cannot make the verifier buffer more. */
async function readCappedBody(res: Response, controller: AbortController): Promise<Uint8Array | "oversize"> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > MAX_SINGLE_BLOCK_BYTES ? "oversize" : whole;
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SINGLE_BLOCK_BYTES) {
      reader.cancel().catch(() => {});
      controller.abort();
      return "oversize";
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

export type PinnedRead<J> =
  | { delivered: true; gateway: string; verdict: J }
  | { delivered: false; attempts: Array<{ gateway: string; failure: string }> };

/**
 * Ask each gateway in order for the file of `cid`. A gateway delivers when its bytes re-encode to the CID: `judge`
 * then decides, and no further gateway is asked. An HTTP or network error, a body over one block, or bytes that do not
 * re-encode move to the next gateway. When the CID cannot be recomputed, only bytes `judge` accepts are believed
 * (`accepts`): a hash that matches vouches for itself, a mismatch proves nothing about the pinned file.
 * TRAP: never send `accept: application/json`; a gateway may answer it with a DAG-JSON rendering of the node.
 */
export async function readPinnedFile<J>(
  cid: string,
  gateways: readonly IpfsGateway[],
  fetchImpl: typeof fetch,
  attemptMs: number,
  judge: (bytes: Uint8Array) => J,
  accepts: (verdict: J) => boolean,
): Promise<PinnedRead<J>> {
  const computable = cidIsComputable(cid);
  const attempts: Array<{ gateway: string; failure: string }> = [];
  for (const gateway of gateways) {
    let url: string;
    try {
      url = gatewayUrl(gateway, cid);
    } catch {
      attempts.push({ gateway: typeof gateway === "string" ? gateway : "the gateway function", failure: "it gave no URL" });
      continue;
    }
    const name = gatewayName(gateway, url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        attempts.push({ gateway: name, failure: `HTTP ${String(res.status)}` });
        continue;
      }
      const bytes = await readCappedBody(res, controller);
      if (bytes === "oversize") {
        attempts.push({ gateway: name, failure: `a body over ${String(MAX_SINGLE_BLOCK_BYTES)} bytes` });
        continue;
      }
      if (computable) {
        if (bytesMatchCid(cid, bytes) !== true) {
          attempts.push({ gateway: name, failure: "bytes that do not re-encode to the CID" });
          continue;
        }
        return { delivered: true, gateway: name, verdict: judge(bytes) };
      }
      const verdict = judge(bytes);
      if (accepts(verdict)) return { delivered: true, gateway: name, verdict };
      attempts.push({ gateway: name, failure: "bytes that do not match the signed hash, under a CID this verifier cannot recompute" });
    } catch {
      attempts.push({ gateway: name, failure: "no answer (network error or timeout)" });
    } finally {
      clearTimeout(timer);
    }
  }
  return { delivered: false, attempts };
}
