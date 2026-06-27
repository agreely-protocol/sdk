<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * A page of consent requests. Note the SDK surfaces `items` (the server wire
 * field is `requests`); `nextCursor` is null when the list is exhausted.
 */
final class ConsentRequestPage
{
    /**
     * @param list<ConsentRequestRecord> $items
     */
    public function __construct(
        public readonly array $items,
        public readonly ?string $nextCursor,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            array_map(
                static fn (array $r): ConsentRequestRecord => ConsentRequestRecord::fromWire($r),
                Wire::objects($wire, 'requests'),
            ),
            Wire::nullableStr($wire['nextCursor'] ?? null),
        );
    }
}
