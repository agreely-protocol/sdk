<?php

declare(strict_types=1);

namespace Agreely\Sdk\Crypto;

use RuntimeException;

/** Thrown when a value cannot be JCS-canonicalized (a number, a non-ASCII key, …). */
final class CanonicalizationException extends RuntimeException
{
}
