<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The 200 body from POST /v1/consent-requests/{id}/cancel. `cancelled` is true
 * only when THIS call flipped a pending request to revoked_before_action; false
 * on an idempotent no-op against an already-terminal request (not an error).
 * `status` is the request's status AFTER the call.
 */
final class CancelledRequest
{
    public function __construct(
        public readonly string $requestId,
        public readonly string $status,
        public readonly bool $cancelled,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['requestId'] ?? null),
            Wire::str($wire['status'] ?? null),
            Wire::bool($wire['cancelled'] ?? false),
        );
    }
}
