<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * Tiny coercion helpers for mapping a decoded JSON object (whose values are
 * `mixed`) onto the typed result classes. Keeps the mappers total and explicit
 * under phpstan level max.
 */
final class Wire
{
    public static function str(mixed $value, string $default = ''): string
    {
        return is_scalar($value) ? (string) $value : $default;
    }

    public static function nullableStr(mixed $value): ?string
    {
        return $value === null ? null : self::str($value);
    }

    public static function bool(mixed $value): bool
    {
        return (bool) $value;
    }

    /**
     * Coerce a wire array field into a list of strings (non-scalar entries dropped).
     *
     * @param array<string,mixed> $wire
     * @return list<string>
     */
    public static function strings(array $wire, string $key): array
    {
        $value = $wire[$key] ?? null;
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach (array_values($value) as $entry) {
            if (is_scalar($entry)) {
                $out[] = (string) $entry;
            }
        }
        return $out;
    }

    /**
     * @param array<string,mixed> $wire
     * @return list<array<string,mixed>>
     */
    public static function objects(array $wire, string $key): array
    {
        $value = $wire[$key] ?? null;
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach (array_values($value) as $entry) {
            if (is_array($entry)) {
                /** @var array<string,mixed> $entry */
                $out[] = $entry;
            }
        }
        return $out;
    }
}
