<?php

declare(strict_types=1);

namespace Agreely\Sdk\Resources;

use Agreely\Sdk\Http\RequestSpec;
use Agreely\Sdk\Http\Transport;
use Agreely\Sdk\Types\CatalogEntry;
use Agreely\Sdk\Types\Wire;

/**
 * The catalog resource (scope: 'check' OR 'issue') — read-only discovery of the
 * company's declared active (category, purpose) entries, for composing issuance.
 */
final class Catalog
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * The company's active declared catalog.
     *
     * @return list<CatalogEntry>
     */
    public function list(): array
    {
        $wire = $this->transport->request(new RequestSpec(
            method: 'GET',
            path: '/v1/catalog',
            idempotentRetry: true,
        ));
        return array_map(
            static fn (array $e): CatalogEntry => CatalogEntry::fromWire($e),
            Wire::objects($wire, 'catalog'),
        );
    }
}
