<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The full result of a check. `check()` returns the boolean; this is the reasoned
 * form. Mirrors the openapi CheckDecision shape.
 *
 *   decision  -> "allow" | "deny" (ALLOW is the only true)
 *   status    -> "active" | "none" | "revoked" | "expired" | "erased" |
 *                "relationship_ended" ("relationship_ended" -> deny: the company
 *                attested the relationship is over (art. 23); the per-cell consent
 *                stays truthfully active, it was never withdrawn)
 *   consentRef -> 0x-hex enforcement handle; ABSENT (null) when status is "none"
 *   degraded  -> true ONLY when synthesized by the local degrade policy on an
 *                outage (never set on a real server decision)
 *   mode      -> the degrade mode that produced a degraded allow ("fail-open")
 *   assurance -> how the enforcement record was established
 *                ("citizen_signed" | "company_attested"); present whenever a
 *                record exists, null for status "none" and on a degraded result
 */
final class CheckResult
{
    public function __construct(
        public readonly string $decision,
        public readonly string $status,
        public readonly ?string $consentRef,
        public readonly string $checkedAt,
        public readonly bool $degraded = false,
        public readonly ?string $mode = null,
        public readonly ?string $assurance = null,
    ) {
    }

    /** @param array<string,mixed> $wire */
    public static function fromWire(array $wire): self
    {
        return new self(
            Wire::str($wire['decision'] ?? null),
            Wire::str($wire['status'] ?? null),
            Wire::nullableStr($wire['consentRef'] ?? null),
            Wire::str($wire['checkedAt'] ?? null),
            assurance: Wire::nullableStr($wire['assurance'] ?? null),
        );
    }

    /** True when the decision is an allow (the only true). */
    public function isAllow(): bool
    {
        return $this->decision === 'allow';
    }
}
