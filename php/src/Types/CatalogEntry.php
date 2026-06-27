<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** A declared active catalog entry, for issuance discovery. */
final class CatalogEntry
{
    public function __construct(
        public readonly string $id,
        public readonly string $category,
        public readonly string $purpose,
        public readonly ?string $description,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['id'] ?? null),
            Wire::str($wire['category'] ?? null),
            Wire::str($wire['purpose'] ?? null),
            Wire::nullableStr($wire['description'] ?? null),
        );
    }
}
