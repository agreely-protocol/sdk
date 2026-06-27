<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Support;

use Agreely\Sdk\Http\HttpClient;
use Agreely\Sdk\Http\RawResponse;
use Agreely\Sdk\Http\TransportException;

/**
 * A scripted HttpClient for the unit suite (mirrors the TS mockFetch). Each script
 * entry is consumed in order and is either a RawResponse, a TransportException to
 * throw, or a callable(MockCall): RawResponse|TransportException that can inspect
 * the call. Every call is recorded for assertions. The last entry is reused if the
 * script runs short.
 */
final class MockHttpClient implements HttpClient
{
    /** @var list<RawResponse|TransportException|callable(MockCall):(RawResponse|TransportException)> */
    private array $script;

    /** @var list<MockCall> */
    public array $calls = [];

    private int $i = 0;

    /**
     * @param list<RawResponse|TransportException|callable(MockCall):(RawResponse|TransportException)> $script
     */
    public function __construct(array $script)
    {
        $this->script = $script;
    }

    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutMs): RawResponse
    {
        /** @var array<string,mixed>|null $decodedBody */
        $decodedBody = $body !== null ? json_decode($body, true) : null;
        $call = new MockCall($method, $url, $headers, is_array($decodedBody) ? $decodedBody : null, $timeoutMs);
        $this->calls[] = $call;

        if ($this->script === []) {
            throw new \RuntimeException('MockHttpClient: empty script');
        }
        $entry = $this->script[min($this->i, count($this->script) - 1)];
        $this->i++;

        $result = is_callable($entry) ? $entry($call) : $entry;
        if ($result instanceof TransportException) {
            throw $result;
        }
        return $result;
    }

    /** @param array<string,string|int> $headers */
    public static function json(int $status, mixed $body, array $headers = []): RawResponse
    {
        $lowered = [];
        foreach ($headers as $k => $v) {
            $lowered[strtolower($k)] = (string) $v;
        }
        return new RawResponse($status, $body === null ? '' : (string) json_encode($body), $lowered);
    }

    public static function network(): TransportException
    {
        return new TransportException('Agreely could not be reached (network error).', false);
    }

    public static function timeout(): TransportException
    {
        return new TransportException('Agreely request timed out.', true);
    }
}
