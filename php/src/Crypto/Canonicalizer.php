<?php

declare(strict_types=1);

namespace Agreely\Sdk\Crypto;

use stdClass;

/**
 * A strict, NUMBER-FREE JCS (RFC 8785) canonicalizer — a byte-for-byte port of
 * the Agreely app's App\Models\Crypto\Canonicalizer and of the TS SDK's
 * crypto/jcs.ts. The output is the deterministic UTF-8 byte string a verifier
 * re-canonicalizes and hashes, so it MUST match across PHP, TS and the server:
 *
 *   - Accepts ONLY strings, objects, arrays, booleans and null.
 *   - THROWS on any int / float (numbers are the classic cross-language footgun).
 *   - No whitespace. Object keys are ASCII-only and byte-order sorted.
 *   - Strings: escape only " and \ and the control range U+0000-U+001F, using the
 *     short forms \b \t \n \f \r where they exist, otherwise \u00xx. "/" is NOT
 *     escaped; non-ASCII passes through as raw UTF-8.
 */
final class Canonicalizer
{
    public function encode(mixed $value): string
    {
        return $this->encodeValue($value);
    }

    private function encodeValue(mixed $value): string
    {
        if (is_string($value)) {
            return $this->encodeString($value);
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if ($value === null) {
            return 'null';
        }
        if (is_array($value)) {
            return array_is_list($value)
                ? $this->encodeArray($value)
                : $this->encodeObject($value);
        }
        if ($value instanceof stdClass) {
            return $this->encodeObject((array) $value);
        }

        throw new CanonicalizationException(sprintf(
            'Canonicalizer: unsupported value of type %s. Only string/object/array/bool/null '
            . 'are allowed; numbers must travel as strings.',
            get_debug_type($value),
        ));
    }

    /** @param array<int, mixed> $list */
    private function encodeArray(array $list): string
    {
        $parts = [];
        foreach ($list as $item) {
            $parts[] = $this->encodeValue($item);
        }
        return '[' . implode(',', $parts) . ']';
    }

    /** @param array<array-key, mixed> $object */
    private function encodeObject(array $object): string
    {
        $keys = [];
        foreach (array_keys($object) as $key) {
            if (!is_string($key)) {
                throw new CanonicalizationException(sprintf(
                    'Canonicalizer: object keys must be strings, got %s.',
                    get_debug_type($key),
                ));
            }
            if (!self::isAscii($key)) {
                throw new CanonicalizationException('Canonicalizer: object keys must be ASCII-only.');
            }
            $keys[] = $key;
        }

        usort($keys, static fn (string $a, string $b): int => strcmp($a, $b));

        $parts = [];
        foreach ($keys as $key) {
            $parts[] = $this->encodeString($key) . ':' . $this->encodeValue($object[$key]);
        }
        return '{' . implode(',', $parts) . '}';
    }

    private function encodeString(string $string): string
    {
        if (!mb_check_encoding($string, 'UTF-8')) {
            throw new CanonicalizationException('Canonicalizer: string is not valid UTF-8.');
        }

        $out = '"';
        $length = strlen($string);
        for ($i = 0; $i < $length; $i++) {
            $char = $string[$i];
            switch ($char) {
                case '"':
                    $out .= '\\"';
                    break;
                case '\\':
                    $out .= '\\\\';
                    break;
                case "\x08":
                    $out .= '\\b';
                    break;
                case "\x09":
                    $out .= '\\t';
                    break;
                case "\x0A":
                    $out .= '\\n';
                    break;
                case "\x0C":
                    $out .= '\\f';
                    break;
                case "\x0D":
                    $out .= '\\r';
                    break;
                default:
                    $code = ord($char);
                    if ($code < 0x20) {
                        $out .= sprintf('\\u%04x', $code);
                    } else {
                        $out .= $char;
                    }
            }
        }
        return $out . '"';
    }

    private static function isAscii(string $string): bool
    {
        return preg_match('/[^\x00-\x7F]/', $string) !== 1;
    }
}
