<?php

declare(strict_types=1);

namespace Agreely\Sdk\Degrade;

/** The outcome of evaluating an outage against the degrade policy. */
final class DegradeDecision
{
    public function __construct(
        public readonly bool $allow,
        public readonly ?string $mode = null,
    ) {
    }
}
