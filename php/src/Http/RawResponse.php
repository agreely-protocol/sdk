<?php

declare(strict_types=1);

namespace Agreely\Sdk\Http;

/** A raw HTTP response as returned by an HttpClient: status, body text, headers. */
final class RawResponse
{
    /** @param array<string,string> $headers header names lower-cased */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = [],
    ) {
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }
}
