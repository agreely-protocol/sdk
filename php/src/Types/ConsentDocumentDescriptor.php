<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The bound consent document snapshot (code, name, version) the signed offer
 * commits to. Null on legacy records issued before the document became
 * mandatory.
 */
final class ConsentDocumentDescriptor
{
    public function __construct(
        public readonly string $code,
        public readonly string $name,
        public readonly string $version,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['code'] ?? null),
            Wire::str($wire['name'] ?? null),
            Wire::str($wire['version'] ?? null),
        );
    }

    public static function fromWireNullable(mixed $wire): ?self
    {
        if (!is_array($wire)) {
            return null;
        }
        /** @var array<string,mixed> $wire (JSON objects decode to string keys) */
        return self::fromWire($wire);
    }
}
