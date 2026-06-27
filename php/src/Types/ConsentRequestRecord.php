<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * A consent request record as returned by list/get. Keyed on the protocol
 * requestId (0x-prefixed 64-hex), NOT an internal uuid.
 */
final class ConsentRequestRecord
{
    /**
     * @param list<ItemLabels> $items
     */
    public function __construct(
        public readonly string $requestId,
        public readonly string $status,
        public readonly string $validUntil,
        public readonly string $expiresAt,
        public readonly string $createdAt,
        public readonly ?string $settledAt,
        public readonly array $items,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['requestId'] ?? null),
            Wire::str($wire['status'] ?? null),
            Wire::str($wire['validUntil'] ?? null),
            Wire::str($wire['expiresAt'] ?? null),
            Wire::str($wire['createdAt'] ?? null),
            Wire::nullableStr($wire['settledAt'] ?? null),
            ItemLabels::listFromWire(Wire::objects($wire, 'items')),
        );
    }
}
