<?php

declare(strict_types=1);

namespace Agreely\Sdk\Http;

/**
 * A low-level transport failure (network unreachable or timeout) raised by an
 * HttpClient. The Transport maps it to a typed AgreelyUnavailableError. `timedOut`
 * distinguishes a budget timeout from a connection failure (both are retryable).
 */
final class TransportException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly bool $timedOut = false,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}
