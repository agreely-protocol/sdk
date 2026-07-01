<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/**
 * The client-side poll budget (e.g. ConsentRequests::waitForSettlement) elapsed
 * before the resource reached a terminal state. NOT a server outage — the
 * last-seen status is attached so a caller can decide whether to keep waiting.
 * Mirrors the TS SDK's AgreelyTimeoutError.
 */
final class AgreelyTimeoutError extends AgreelyError
{
    /** The last status observed before the timeout, when known. */
    public readonly ?string $lastStatus;

    public function __construct(string $message, ?string $lastStatus = null, ?\Throwable $previous = null)
    {
        parent::__construct($message, 'timeout', null, null, $previous);
        $this->lastStatus = $lastStatus;
    }
}
