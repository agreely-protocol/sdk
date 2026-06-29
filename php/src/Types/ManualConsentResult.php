<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The 201 body from recording a manual / offline (company-attested) consent.
 * `assurance` is always "company_attested" for this path (vs the citizen-signed
 * live flow); `anchored` is false at record time.
 */
final class ManualConsentResult
{
    /**
     * @param list<string> $consentRefs one 0x-hex enforcement handle per recorded cell
     */
    public function __construct(
        public readonly string $consentId,
        public readonly string $merkleRoot,
        public readonly array $consentRefs,
        public readonly string $assurance,
        public readonly bool $anchored,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['consentId'] ?? null),
            Wire::str($wire['merkleRoot'] ?? null),
            Wire::strings($wire, 'consentRefs'),
            Wire::str($wire['assurance'] ?? null, 'company_attested'),
            Wire::bool($wire['anchored'] ?? false),
        );
    }
}
