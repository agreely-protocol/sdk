<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/** A misconfiguration caught at construction time (e.g. fail-open without onDegrade). */
class AgreelyConfigError extends AgreelyError
{
    public function __construct(string $message)
    {
        parent::__construct($message, 'config');
    }
}
