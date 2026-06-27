<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** The 201 body from issuance (or an idempotent replay of it). */
final class IssuedRequest
{
    /**
     * @param list<ItemLabels> $items
     */
    public function __construct(
        /** The protocol handle (0x-prefixed 64-hex). The public identifier. */
        public readonly string $requestId,
        public readonly string $status,
        /** The recipient's secure approval link. */
        public readonly string $deepLink,
        public readonly bool $emailDelivered,
        public readonly array $items,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['requestId'] ?? null),
            Wire::str($wire['status'] ?? null, 'pending'),
            Wire::str($wire['deepLink'] ?? null),
            Wire::bool($wire['emailDelivered'] ?? false),
            ItemLabels::listFromWire(Wire::objects($wire, 'items')),
        );
    }
}
