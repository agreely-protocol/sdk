<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** The decision for one item in a POST /v1/check/batch response. */
final class BatchDecision
{
    public function __construct(
        public readonly string $customerRef,
        public readonly string $category,
        public readonly string $purpose,
        public readonly string $decision,
        public readonly string $status,
        public readonly ?string $consentRef,
        public readonly ?string $assurance,
        public readonly string $checkedAt,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['customerRef'] ?? null),
            Wire::str($wire['category'] ?? null),
            Wire::str($wire['purpose'] ?? null),
            Wire::str($wire['decision'] ?? null),
            Wire::str($wire['status'] ?? null),
            Wire::nullableStr($wire['consentRef'] ?? null),
            Wire::nullableStr($wire['assurance'] ?? null),
            Wire::str($wire['checkedAt'] ?? null),
        );
    }

    /** True when the decision is an allow (the only true). */
    public function isAllow(): bool
    {
        return $this->decision === 'allow';
    }
}
