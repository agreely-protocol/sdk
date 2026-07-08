<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The 200 body from POST /v1/customers/{customerRef}/relationship/revert. Undoing
 * a mistaken company-attested end (art. 11 / art. 28 correction of an inaccurate
 * record) returns the relationship to 'active'; the still-active consents (never
 * withdrawn) apply again. Company-side facts only. NEVER a DID or a consent_ref.
 */
final class RelationshipReverted
{
    public function __construct(
        public readonly string $customerRef,
        public readonly string $status,
        public readonly bool $reverted,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['customerRef'] ?? null),
            Wire::str($wire['status'] ?? null),
            Wire::bool($wire['reverted'] ?? false),
        );
    }
}
