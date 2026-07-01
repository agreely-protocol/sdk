<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/** 429 — the per-company rate window was exceeded. */
class AgreelyRateLimitError extends AgreelyError
{
    /** Seconds until the window resets (from the Retry-After header), when given. */
    public readonly ?int $retryAfter;
    /** Alias of {@see $retryAfter} with an explicit unit in the name. */
    public readonly ?int $retryAfterSeconds;

    public function __construct(
        string $message,
        string $code = 'rate_limited',
        ?int $status = null,
        ?int $retryAfter = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, $code, $status, null, $previous);
        $this->retryAfter = $retryAfter;
        $this->retryAfterSeconds = $retryAfter;
    }
}
