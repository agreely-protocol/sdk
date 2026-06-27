<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/**
 * 503 / network error / timeout — Agreely was unreachable. This is the ONLY
 * error subject to the degrade policy. `retryable` marks the transient cases
 * (503, network, timeout) the transport may retry for idempotent calls.
 */
class AgreelyUnavailableError extends AgreelyError
{
    public readonly bool $retryable;

    public function __construct(
        string $message,
        ?int $status = null,
        bool $retryable = false,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 'unavailable', $status, null, $previous);
        $this->retryable = $retryable;
    }
}
