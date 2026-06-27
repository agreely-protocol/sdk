<?php

declare(strict_types=1);

namespace Agreely\Sdk\Http;

/**
 * The default minimal curl-based HttpClient. Pure HTTP: one request, one raw
 * response. A network failure or a timeout throws TransportException (the
 * Transport maps it to AgreelyUnavailableError). Honours the per-call time budget
 * via CURLOPT_TIMEOUT_MS.
 */
final class CurlHttpClient implements HttpClient
{
    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutMs): RawResponse
    {
        $ch = curl_init();
        if ($ch === false) {
            throw new TransportException('Failed to initialise curl.');
        }

        $headerLines = [];
        foreach ($headers as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }

        /** @var array<string,string> $responseHeaders */
        $responseHeaders = [];

        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => $timeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => $timeoutMs,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HEADERFUNCTION => static function ($_ch, string $line) use (&$responseHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $raw = curl_exec($ch);
        $errno = curl_errno($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        // curl_close() is a no-op since PHP 8.0 (deprecated in 8.5); the handle is
        // freed when $ch goes out of scope.

        if ($errno !== 0 || $raw === false) {
            $timedOut = $errno === CURLE_OPERATION_TIMEDOUT;
            $message = $timedOut
                ? 'Agreely request timed out.'
                : 'Agreely could not be reached (network error): ' . $error;
            throw new TransportException($message, $timedOut);
        }

        return new RawResponse($status, is_string($raw) ? $raw : '', $responseHeaders);
    }
}
