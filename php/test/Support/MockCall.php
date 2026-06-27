<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Support;

/** One recorded request the MockHttpClient saw. */
final class MockCall
{
    /**
     * @param array<string,string> $headers
     * @param array<string,mixed>|null $body the JSON-decoded request body
     */
    public function __construct(
        public readonly string $method,
        public readonly string $url,
        public readonly array $headers,
        public readonly ?array $body,
        public readonly int $timeoutMs,
    ) {
    }

    public function header(string $name): ?string
    {
        foreach ($this->headers as $key => $value) {
            if (strcasecmp($key, $name) === 0) {
                return $value;
            }
        }
        return null;
    }

    public function path(): string
    {
        return (string) parse_url($this->url, PHP_URL_PATH);
    }

    public function query(): string
    {
        return (string) (parse_url($this->url, PHP_URL_QUERY) ?: '');
    }
}
