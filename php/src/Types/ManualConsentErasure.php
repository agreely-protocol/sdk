<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** The 200 body from erasing a manual consent. The call is idempotent server-side. */
final class ManualConsentErasure
{
    public function __construct(
        public readonly string $consentRef,
        public readonly bool $erased,
        public readonly bool $alreadyErased,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['consentRef'] ?? null),
            Wire::bool($wire['erased'] ?? false),
            Wire::bool($wire['alreadyErased'] ?? false),
        );
    }
}
