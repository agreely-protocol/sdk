<?php

declare(strict_types=1);

namespace Agreely\Sdk\Http;

/**
 * The pluggable, pure-HTTP transport contract. Implementations do ONE thing: send
 * one request and return the raw response (or throw TransportException on a
 * network failure / timeout). NO retries, NO error mapping, NO state — those live
 * in the Transport. Integrators can bring their own (Guzzle/PSR-18 adapter); the
 * default is a minimal curl client.
 */
interface HttpClient
{
    /**
     * @param 'GET'|'POST' $method
     * @param array<string,string> $headers
     * @throws TransportException on a network failure or a timeout
     */
    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutMs): RawResponse;
}
