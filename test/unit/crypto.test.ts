import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agreely } from "../../src/index.js";
import { keccak256Hex } from "../../src/crypto/keccak.js";
import { canonicalize } from "../../src/crypto/jcs.js";
import { base58btcDecode, decodeEd25519PublicKeyMultibase } from "../../src/crypto/encoding.js";

describe("keccak256", () => {
  it("matches the known empty-input vector (Ethereum keccak, not SHA3)", () => {
    expect(keccak256Hex("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("matches keccak256('abc')", () => {
    expect(keccak256Hex("abc")).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });
});

describe("Agreely.hashPdf", () => {
  it("returns 0x + sha256 hex exactly as the API expects", () => {
    const bytes = new TextEncoder().encode("hello world");
    const expected = "0x" + createHash("sha256").update(bytes).digest("hex");
    expect(Agreely.hashPdf(bytes)).toBe(expected);
    expect(Agreely.hashPdf(bytes)).toBe(
      "0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

describe("JCS canonicalizer", () => {
  it("sorts keys and forbids numbers", () => {
    expect(canonicalize({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
    expect(() => canonicalize({ n: 1 })).toThrow();
  });
});

describe("base58btc / multibase", () => {
  it("round-trips a known multibase Ed25519 key", () => {
    const mb = "z6MkuDgiyAErthaCSCNj71p31Bo5DC5Gw8RBMtEb9c8YA5Kd";
    const raw = decodeEd25519PublicKeyMultibase(mb);
    expect(raw.length).toBe(32);
  });

  it("decodes base58btc leading-zero bytes to leading 0x00", () => {
    const bytes = base58btcDecode("1112");
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(0);
  });
});
