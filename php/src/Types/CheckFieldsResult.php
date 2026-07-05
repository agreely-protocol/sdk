<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/**
 * The result of Agreely::checkFields: a pre-built lookup for a
 * (customerRef, category, purpose) cartesian product.
 */
final class CheckFieldsResult
{
    /** @var array<string, bool> */
    private array $map;

    /**
     * @param list<BatchDecision> $decisions
     */
    public function __construct(public readonly array $decisions)
    {
        $this->map = [];
        foreach ($decisions as $d) {
            $this->map[$d->customerRef . "\0" . $d->category . "\0" . $d->purpose] = $d->isAllow();
        }
    }

    /**
     * Boolean gate. Returns true ONLY when the decision for this exact
     * (customerRef, category, purpose) triple is "allow". Strings are compared
     * as submitted to checkFields (the server normalizes; the SDK sends raw).
     */
    public function isAllowed(string $customerRef, string $category, string $purpose): bool
    {
        return $this->map[$customerRef . "\0" . $category . "\0" . $purpose] ?? false;
    }
}
