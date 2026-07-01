<?php

declare(strict_types=1);

namespace Agreely\Sdk\Crypto;

use RuntimeException;

/**
 * A minimal CBOR reader — just enough to parse a WebAuthn COSE_Key map: unsigned
 * ints (major 0), negative ints (major 1), byte strings (major 2) and the map
 * header (major 5). Mirrors the TS SDK's parseCoseKey. Returns the fields the
 * verifier needs; unsupported algorithms resolve to alg 'unsupported'.
 */
final class Cose
{
    /**
     * @return array{alg:'ES256'|'EdDSA'|'unsupported', x:string, y:?string}
     */
    public static function parseKey(string $bytes): array
    {
        $pos = 0;
        $map = self::readMap($bytes, $pos);

        $kty = $map[1] ?? null;
        $alg = $map[3] ?? null;
        $x = $map[-2] ?? null;
        $y = $map[-3] ?? null;

        if ($kty === 2 && $alg === -7 && is_string($x) && is_string($y)) {
            return ['alg' => 'ES256', 'x' => $x, 'y' => $y];
        }
        if ($kty === 1 && $alg === -8 && is_string($x)) {
            return ['alg' => 'EdDSA', 'x' => $x, 'y' => null];
        }
        return ['alg' => 'unsupported', 'x' => is_string($x) ? $x : '', 'y' => null];
    }

    /**
     * @return array<int, int|string>
     */
    private static function readMap(string $buf, int &$pos): array
    {
        $major = ord($buf[$pos]) >> 5;
        if ($major !== 5) {
            throw new RuntimeException('COSE key must be a CBOR map.');
        }
        $n = self::readLength($buf, $pos);
        $map = [];
        for ($i = 0; $i < $n; $i++) {
            $key = self::readInt($buf, $pos);
            $map[$key] = self::readValue($buf, $pos);
        }
        return $map;
    }

    private static function readLength(string $buf, int &$pos): int
    {
        $info = ord($buf[$pos]) & 0x1f;
        $pos++;
        if ($info < 24) {
            return $info;
        }
        if ($info === 24) {
            return ord($buf[$pos++]);
        }
        if ($info === 25) {
            $v = (ord($buf[$pos]) << 8) | ord($buf[$pos + 1]);
            $pos += 2;
            return $v;
        }
        throw new RuntimeException('Unsupported CBOR length encoding in COSE key.');
    }

    private static function readInt(string $buf, int &$pos): int
    {
        $major = ord($buf[$pos]) >> 5;
        $value = self::readLength($buf, $pos);
        if ($major === 0) {
            return $value;
        }
        if ($major === 1) {
            return -1 - $value;
        }
        throw new RuntimeException('Expected an integer CBOR key in COSE key.');
    }

    private static function readValue(string $buf, int &$pos): int|string
    {
        $major = ord($buf[$pos]) >> 5;
        if ($major === 0) {
            return self::readLength($buf, $pos);
        }
        if ($major === 1) {
            return -1 - self::readLength($buf, $pos);
        }
        if ($major === 2) {
            $len = self::readLength($buf, $pos);
            $out = substr($buf, $pos, $len);
            $pos += $len;
            return $out;
        }
        throw new RuntimeException('Unsupported CBOR value type in COSE key.');
    }
}
