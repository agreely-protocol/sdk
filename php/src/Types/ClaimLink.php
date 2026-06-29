<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** A claim link the company hands to the subject to self-claim a recorded attestation. */
final class ClaimLink
{
    public function __construct(
        public readonly string $claimUrl,
        public readonly string $token,
        public readonly string $expiresAt,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['claimUrl'] ?? null),
            Wire::str($wire['token'] ?? null),
            Wire::str($wire['expiresAt'] ?? null),
        );
    }
}
