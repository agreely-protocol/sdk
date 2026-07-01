<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The least-disclosure identity of the presented key, from GET /v1/whoami. The
 * WIRE response carries ONLY the key's own scopes — no company id, no key name,
 * no counters, no PII. `baseUrl` is added CLIENT-SIDE (the configured endpoint),
 * never part of the wire body; it is null when the type is built from the wire
 * alone.
 */
final class Identity
{
    /**
     * @param list<string> $scopes the presented key's scopes, as the server reports them
     */
    public function __construct(
        public readonly array $scopes,
        public readonly ?string $baseUrl = null,
    ) {
    }

    /**
     * @param array<string,mixed> $wire
     */
    public static function fromWire(array $wire, ?string $baseUrl = null): self
    {
        return new self(Wire::strings($wire, 'scopes'), $baseUrl);
    }
}
