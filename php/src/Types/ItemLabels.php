<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** One (category, purpose) label pair, as the server echoes it back. */
final class ItemLabels
{
    public function __construct(
        public readonly string $category,
        public readonly string $purpose,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(Wire::str($wire['category'] ?? null), Wire::str($wire['purpose'] ?? null));
    }

    /**
     * @param list<array<string,mixed>> $wire
     * @return list<self>
     */
    public static function listFromWire(array $wire): array
    {
        return array_map(static fn (array $w): self => self::fromWire($w), array_values($wire));
    }
}
