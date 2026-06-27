<?php

declare(strict_types=1);

namespace Agreely\Sdk\Http;

/** One wire request the Transport will execute. */
final class RequestSpec
{
    /**
     * @param 'GET'|'POST' $method
     * @param array<string,string|null> $query
     * @param array<string,mixed>|null $body
     * @param array<string,string> $headers
     * @param bool $idempotentRetry Whether this call may be retried on a transient
     *   outage (network / 503). TRUE only for idempotent reads and the check (a
     *   pure read). NEVER for consentRequests.create — it emails; a retry there
     *   must replay via the Idempotency-Key, not re-issue.
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query = [],
        public readonly ?array $body = null,
        public readonly array $headers = [],
        public readonly bool $idempotentRetry = false,
    ) {
    }
}
