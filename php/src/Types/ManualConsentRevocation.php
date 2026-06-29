<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** The 200 body from revoking a manual consent. The call is idempotent server-side. */
final class ManualConsentRevocation
{
    public function __construct(
        public readonly string $consentRef,
        public readonly bool $revoked,
        public readonly bool $alreadyRevoked,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['consentRef'] ?? null),
            Wire::bool($wire['revoked'] ?? false),
            Wire::bool($wire['alreadyRevoked'] ?? false),
        );
    }
}
