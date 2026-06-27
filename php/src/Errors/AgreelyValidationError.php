<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/** 400 / 422 — malformed or invalid input. `field` names the offending input when known. */
class AgreelyValidationError extends AgreelyError
{
}
