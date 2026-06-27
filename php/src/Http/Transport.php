<?php

declare(strict_types=1);

namespace Agreely\Sdk\Http;

use Agreely\Sdk\Errors\AgreelyAuthError;
use Agreely\Sdk\Errors\AgreelyError;
use Agreely\Sdk\Errors\AgreelyNotFoundError;
use Agreely\Sdk\Errors\AgreelyRateLimitError;
use Agreely\Sdk\Errors\AgreelyUnavailableError;
use Agreely\Sdk\Errors\AgreelyValidationError;

/**
 * The thin HTTP layer, ported from the TS transport.ts: build the request,
 * enforce a SINGLE total time budget across attempts, map every response/failure
 * to a typed error, and retry ONLY idempotent calls on a transient outage
 * (network error or 503), capped at two attempts with jittered backoff, all
 * inside the budget.
 */
final class Transport
{
    private readonly string $baseUrl;

    public function __construct(
        string $baseUrl,
        private readonly string $apiKey,
        private readonly int $timeoutMs,
        private readonly HttpClient $http,
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /**
     * @return array<string,mixed> the decoded JSON object
     */
    public function request(RequestSpec $spec): array
    {
        $url = $this->buildUrl($spec->path, $spec->query);
        $headers = array_merge([
            'Authorization' => 'Bearer ' . $this->apiKey,
            'Accept' => 'application/json',
        ], $spec->headers);

        $bodyText = null;
        if ($spec->body !== null) {
            $headers['Content-Type'] = 'application/json';
            $bodyText = (string) json_encode($spec->body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }

        $deadlineMs = $this->nowMs() + $this->timeoutMs;
        $maxAttempts = $spec->idempotentRetry ? 2 : 1;
        $lastError = null;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            $remaining = $deadlineMs - $this->nowMs();
            if ($remaining <= 0) {
                break;
            }

            try {
                $res = $this->http->send($spec->method, $url, $headers, $bodyText, (int) $remaining);
                return $this->handle($res);
            } catch (TransportException $raw) {
                $lastError = $this->normalize($raw);
            } catch (AgreelyError $typed) {
                // handle() throws typed errors; only AgreelyUnavailableError is retryable.
                $lastError = $typed;
            }

            $transient = $lastError instanceof AgreelyUnavailableError && $lastError->retryable;
            $canRetry = $spec->idempotentRetry && $transient && $attempt < $maxAttempts;
            if (!$canRetry) {
                throw $lastError;
            }

            $backoff = $this->jitterBackoff($attempt);
            if ($this->nowMs() + $backoff >= $deadlineMs) {
                throw $lastError;
            }
            usleep($backoff * 1000);
        }

        throw $lastError ?? new AgreelyUnavailableError(
            'Agreely was unreachable within the time budget.',
            null,
            true,
        );
    }

    /**
     * @param array<string,string|null> $query
     */
    private function buildUrl(string $path, array $query): string
    {
        $url = $this->baseUrl . $path;
        $pairs = [];
        foreach ($query as $key => $value) {
            if ($value !== null && $value !== '') {
                $pairs[$key] = $value;
            }
        }
        if ($pairs !== []) {
            $url .= '?' . http_build_query($pairs);
        }
        return $url;
    }

    /**
     * Map a RawResponse to parsed JSON, or throw the typed error for its status.
     *
     * @return array<string,mixed>
     */
    private function handle(RawResponse $res): array
    {
        if ($res->status >= 200 && $res->status < 300) {
            if ($res->body === '') {
                return [];
            }
            /** @var array<string,mixed> $decoded */
            $decoded = json_decode($res->body, true) ?? [];
            return $decoded;
        }

        $wire = $this->safeErrorEnvelope($res->body);
        $message = $wire['message'] ?? "Agreely request failed (HTTP {$res->status}).";
        $code = $wire['code'] ?? null;
        $field = $wire['field'] ?? null;

        switch ($res->status) {
            case 401:
            case 403:
                throw new AgreelyAuthError($message, $code ?? 'unauthorized', $res->status);
            case 400:
            case 422:
                throw new AgreelyValidationError($message, $code ?? 'invalid_request', $res->status, $field);
            case 404:
                throw new AgreelyNotFoundError($message, $code ?? 'not_found', $res->status);
            case 429:
                $header = $res->header('Retry-After');
                $retryAfter = ($header !== null && is_numeric($header)) ? (int) $header : null;
                throw new AgreelyRateLimitError($message, 'rate_limited', $res->status, $retryAfter);
            default:
                // 503 and any other 5xx: unreachable. 503 is retryable for idempotent calls.
                throw new AgreelyUnavailableError($message, $res->status, $res->status === 503);
        }
    }

    /**
     * @return array{message?:string,code?:string,field?:string}
     */
    private function safeErrorEnvelope(string $body): array
    {
        if ($body === '') {
            return [];
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded) || !isset($decoded['error']) || !is_array($decoded['error'])) {
            return [];
        }
        /** @var array<string,mixed> $err */
        $err = $decoded['error'];
        $out = [];
        if (isset($err['message']) && is_string($err['message'])) {
            $out['message'] = $err['message'];
        }
        if (isset($err['code']) && is_string($err['code'])) {
            $out['code'] = $err['code'];
        }
        if (isset($err['field']) && is_string($err['field'])) {
            $out['field'] = $err['field'];
        }
        return $out;
    }

    /** Turn a transport failure into a typed unavailable error (aborts/network -> unavailable, retryable). */
    private function normalize(TransportException $raw): AgreelyUnavailableError
    {
        return new AgreelyUnavailableError($raw->getMessage(), null, true, $raw);
    }

    /**
     * A small jittered backoff for retry attempt N (1-based), in milliseconds.
     * Full jitter over a tiny base so two retries stay well within an ~800ms budget.
     */
    private function jitterBackoff(int $attempt): int
    {
        $base = 25 * $attempt;
        return random_int(0, max(0, $base - 1));
    }

    private function nowMs(): float
    {
        return microtime(true) * 1000;
    }
}
