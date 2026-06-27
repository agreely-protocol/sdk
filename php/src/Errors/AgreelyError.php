<?php

declare(strict_types=1);

namespace Agreely\Sdk\Errors;

/**
 * Base class for every error the SDK throws. A consent DENY is NOT an error (it
 * is a 200) and never appears here. An integrator can
 * `catch (AgreelyRateLimitError $e)` to branch on the specific failure.
 *
 * Mirrors the TypeScript SDK's AgreelyError (the contract reference).
 *
 * @property-read string $code The canonical wire error code.
 */
class AgreelyError extends \RuntimeException
{
    /**
     * The canonical wire error code:
     * unauthorized|forbidden|invalid_request|not_found|rate_limited|unavailable|config.
     *
     * Exposed as `$e->code` via __get (the name clashes with Exception::$code,
     * which is a non-readonly int, so it cannot be redeclared directly).
     */
    private readonly string $errorCode;

    /** HTTP status, when the error came from a response. */
    public readonly ?int $status;

    /** The offending input field, for validation errors. */
    public readonly ?string $field;

    public function __construct(
        string $message,
        string $code,
        ?int $status = null,
        ?string $field = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
        $this->errorCode = $code;
        $this->status = $status;
        $this->field = $field;
    }

    /** The canonical wire error code (a string, e.g. "forbidden"). */
    public function errorCode(): string
    {
        return $this->errorCode;
    }

    public function __get(string $name): mixed
    {
        if ($name === 'code') {
            return $this->errorCode;
        }
        throw new \LogicException(
            'Undefined property: ' . static::class . '::$' . $name,
        );
    }

    public function __isset(string $name): bool
    {
        return $name === 'code';
    }
}
