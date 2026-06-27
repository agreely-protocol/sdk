<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/** 401 unauthorized OR 403 forbidden — the key is missing, invalid, revoked, or lacks the scope. */
class AgreelyAuthError extends AgreelyError
{
}
