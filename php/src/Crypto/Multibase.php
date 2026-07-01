<?php

declare(strict_types=1);

namespace Agreely\Sdk\Crypto;

use RuntimeException;

/**
 * Multibase / multicodec decode helpers — a byte-for-byte port of the app's
 * App\Models\Crypto\Multibase (and the TS SDK's crypto/encoding.ts). A verifier
 * resolves the company key from the DID document's `publicKeyMultibase` and the
 * detached signature from the proof's multibase `proofValue`, so the base58btc
 * decode must match the encoder exactly.
 */
final class Multibase
{
    /** ed25519-pub multicodec prefix (0xed 0x01). */
    private const ED25519_PUB_MULTICODEC = "\xed\x01";

    private const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    /** Decode a publicKeyMultibase (`z…`) to the raw 32-byte Ed25519 key. */
    public static function decodeEd25519PublicKey(string $multibase): string
    {
        $bytes = self::decodeBytes($multibase);
        if (!str_starts_with($bytes, self::ED25519_PUB_MULTICODEC)) {
            throw new RuntimeException('Multibase: not an ed25519-pub multicodec key.');
        }
        $raw = substr($bytes, strlen(self::ED25519_PUB_MULTICODEC));
        if (strlen($raw) !== 32) {
            throw new RuntimeException('Multibase: decoded key is not 32 bytes.');
        }
        return $raw;
    }

    /** Decode a `z…` base58btc multibase string to its raw bytes (e.g. a 64-byte signature). */
    public static function decodeBytes(string $multibase): string
    {
        if ($multibase === '' || $multibase[0] !== 'z') {
            throw new RuntimeException('Multibase: expected a z-base58btc multibase string.');
        }
        return self::base58btcDecode(substr($multibase, 1));
    }

    private static function base58btcDecode(string $string): string
    {
        $map = array_flip(str_split(self::BASE58_ALPHABET));

        $zeros = strlen($string) - strlen(ltrim($string, '1'));

        $bytes = [0];
        foreach (str_split($string) as $char) {
            if (!isset($map[$char])) {
                throw new RuntimeException('Multibase: invalid base58btc character.');
            }
            $carry = $map[$char];
            foreach ($bytes as $i => $byte) {
                $carry += $byte * 58;
                $bytes[$i] = $carry & 0xff;
                $carry >>= 8;
            }
            while ($carry > 0) {
                $bytes[] = $carry & 0xff;
                $carry >>= 8;
            }
        }

        $out = str_repeat("\x00", $zeros);
        foreach (array_reverse($bytes) as $byte) {
            $out .= chr($byte);
        }
        return $out;
    }
}
