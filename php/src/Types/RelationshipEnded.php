<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The 200 body from POST /v1/customers/{customerRef}/relationship/end. Company-
 * side facts only: the customer's own ref, the terminal lifecycle, when it ended
 * and the recorded ORIGIN of the wind-down ('company', or 'citizen_request' when
 * a citizen close-account request had already begun the ending — the origin is
 * never overwritten). NEVER a DID or a consent_ref.
 */
final class RelationshipEnded
{
    public function __construct(
        public readonly string $customerRef,
        public readonly string $status,
        public readonly string $endedAt,
        public readonly string $endedBy,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['customerRef'] ?? null),
            Wire::str($wire['status'] ?? null),
            Wire::str($wire['endedAt'] ?? null),
            Wire::str($wire['endedBy'] ?? null),
        );
    }
}
