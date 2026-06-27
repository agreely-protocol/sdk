<?php

declare(strict_types=1);

namespace Agreely\Sdk\Degrade;

/**
 * The evidence record emitted for every degraded ALLOW (passed to onDegrade).
 *
 * NOTE: break-glass (gate 3 in the TS SDK) is intentionally OMITTED from the PHP
 * v1 — PHP requests are request-scoped with no long-lived in-process "engaged"
 * state, so break-glass would need a shared store (PSR-16 / a callable) to be
 * meaningful. `breakGlass` is therefore always false here and `reason` is always
 * null; the field is retained for shape parity with the TS DegradeContext.
 */
final class DegradeContext
{
    public function __construct(
        public readonly string $customerId,
        public readonly string $category,
        public readonly string $purpose,
        /** The degrade mode that authorised this allow. Always "fail-open" in PHP v1. */
        public readonly string $mode,
        /** Always false in PHP v1 (break-glass omitted; see the class doc). */
        public readonly bool $breakGlass,
        /** The underlying outage error (503 / network / timeout). */
        public readonly \Throwable $error,
        /** ISO-8601 timestamp of the degraded allow. */
        public readonly string $at,
        /** The operator reason (break-glass only). Always null in PHP v1. */
        public readonly ?string $reason = null,
    ) {
    }
}
