<?php

declare(strict_types=1);

namespace Agreely\Sdk\Crypto;

/**
 * A compact, dependency-free keccak-256 (the Ethereum hash — NOT NIST SHA3-256;
 * the difference is the 0x01 vs 0x06 domain padding byte). Used ONLY to derive the
 * AgreelyRegistry event topic and the keccak256(utf8(cid)) document commitment for
 * the opt-in on-chain documentAnchor check. Mirrors the TS SDK's crypto/keccak.ts
 * and the app's kornrunner/Keccak output. Verified against keccak256("") =
 * c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.
 *
 * 64-bit lanes are native PHP ints (this SDK requires a 64-bit build). Unsigned
 * right shift is emulated via a PHP_INT_MAX mask so the sign bit never leaks.
 */
final class Keccak
{
    private const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
    private const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

    /** Round constants as [hi32, lo32] to dodge >PHP_INT_MAX hex literals. */
    private const RC = [
        [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
        [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
        [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
        [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
        [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
        [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008],
    ];

    /** keccak-256 of the input bytes, returning a 32-byte raw digest. */
    public static function hash(string $input): string
    {
        $rate = 136; // 1088 bits for keccak-256
        $state = array_fill(0, 25, 0);

        $padded = self::pad($input, $rate);
        $len = strlen($padded);
        for ($offset = 0; $offset < $len; $offset += $rate) {
            for ($i = 0; $i < $rate / 8; $i++) {
                $lane = 0;
                for ($b = 0; $b < 8; $b++) {
                    $lane |= ord($padded[$offset + $i * 8 + $b]) << (8 * $b);
                }
                $state[$i] ^= $lane;
            }
            self::keccakF($state);
        }

        $out = '';
        for ($i = 0; $i < 4; $i++) {
            $lane = $state[$i];
            for ($b = 0; $b < 8; $b++) {
                $out .= chr(($lane >> (8 * $b)) & 0xff);
            }
        }
        return $out;
    }

    /** keccak-256 of the input, as a 0x-hex digest. */
    public static function hashHex(string $input): string
    {
        return '0x' . bin2hex(self::hash($input));
    }

    private static function pad(string $input, int $rate): string
    {
        $padLen = $rate - (strlen($input) % $rate);
        $pad = str_repeat("\x00", $padLen);
        $pad[0] = chr((ord($pad[0]) ^ 0x01) & 0xff);
        $pad[$padLen - 1] = chr((ord($pad[$padLen - 1]) ^ 0x80) & 0xff);
        return $input . $pad;
    }

    /** @param array<int,int> $state */
    private static function keccakF(array &$state): void
    {
        for ($round = 0; $round < 24; $round++) {
            // Theta
            $c = [];
            for ($x = 0; $x < 5; $x++) {
                $c[$x] = $state[$x] ^ $state[$x + 5] ^ $state[$x + 10] ^ $state[$x + 15] ^ $state[$x + 20];
            }
            $d = [];
            for ($x = 0; $x < 5; $x++) {
                $d[$x] = $c[($x + 4) % 5] ^ self::rotl($c[($x + 1) % 5], 1);
            }
            for ($i = 0; $i < 25; $i++) {
                $state[$i] ^= $d[$i % 5];
            }

            // Rho + Pi
            $t = $state[1];
            for ($i = 0; $i < 24; $i++) {
                $j = self::PILN[$i];
                $tmp = $state[$j];
                $state[$j] = self::rotl($t, self::ROTC[$i]);
                $t = $tmp;
            }

            // Chi
            for ($y = 0; $y < 25; $y += 5) {
                $row = [$state[$y], $state[$y + 1], $state[$y + 2], $state[$y + 3], $state[$y + 4]];
                for ($x = 0; $x < 5; $x++) {
                    $state[$y + $x] = $row[$x] ^ ((~$row[($x + 1) % 5]) & $row[($x + 2) % 5]);
                }
            }

            // Iota
            [$hi, $lo] = self::RC[$round];
            $state[0] ^= ($hi << 32) | $lo;
        }
    }

    /** Rotate a 64-bit lane left by n bits (n in 1..63). */
    private static function rotl(int $x, int $n): int
    {
        $n &= 63;
        if ($n === 0) {
            return $x;
        }
        return ($x << $n) | self::shr($x, 64 - $n);
    }

    /** Logical (unsigned) right shift by s bits (s in 1..63). */
    private static function shr(int $x, int $s): int
    {
        return ($x >> $s) & (PHP_INT_MAX >> ($s - 1));
    }
}
