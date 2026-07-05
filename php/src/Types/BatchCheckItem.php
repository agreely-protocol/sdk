<?php

declare(strict_types=1);

namespace Agreely\Sdk\Types;

/** One item for a batch check (POST /v1/check/batch). */
final class BatchCheckItem
{
    public function __construct(
        public readonly string $customerRef,
        public readonly string $category,
        public readonly string $purpose,
    ) {
    }

    /** @return array{customerRef:string, category:string, purpose:string} */
    public function toArray(): array
    {
        return [
            'customerRef' => $this->customerRef,
            'category'    => $this->category,
            'purpose'     => $this->purpose,
        ];
    }
}
