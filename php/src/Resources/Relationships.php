<?php

declare(strict_types=1);

namespace Agreely\Sdk\Resources;

use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Http\RequestSpec;
use Agreely\Sdk\Http\Transport;
use Agreely\Sdk\Types\RelationshipEnded;
use Agreely\Sdk\Types\RelationshipReverted;

/**
 * The customer-relationship lifecycle resource (scope: 'relationship'). Keyed on
 * the company's OWN customerRef (the same ref used by check), never a DID.
 */
final class Relationships
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * End a customer relationship (Loi 25 art. 23, "les fins sont accomplies") —
     * the exact company-UI action, exposed for a company's own offboarding flow.
     * The 'reason' is REQUIRED (the attestation must carry its justification): a
     * blank one fails CLOSED client-side (AgreelyConfigError) before any wire call,
     * never a silent end.
     *
     * IDEMPOTENT server-side: re-ending an already-ended relationship is a success
     * (the original endedAt + endedBy origin stand). An unknown or foreign
     * customerRef throws AgreelyNotFoundError (404), with nothing written
     * server-side. Never auto-retried (it mutates).
     *
     * @param array{customerRef:string,reason:string} $input
     */
    public function end(array $input): RelationshipEnded
    {
        $customerRef = trim((string) ($input['customerRef'] ?? ''));
        if ($customerRef === '') {
            throw new AgreelyConfigError('relationships.end requires a "customerRef".');
        }
        $reason = (string) ($input['reason'] ?? '');
        if (trim($reason) === '') {
            throw new AgreelyConfigError(
                'relationships.end requires a "reason": the end of the relationship must carry its justification (art. 23).',
            );
        }

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/customers/' . rawurlencode($customerRef) . '/relationship/end',
            body: ['reason' => $reason],
            idempotentRetry: false,
        ));

        return RelationshipEnded::fromWire($wire);
    }

    /**
     * UNDO a mistaken company-attested end (Loi 25 art. 11 / art. 28 correction of
     * an inaccurate record) — NOT a resurrection of dead consent. Allowed ONLY as a
     * narrow server-side carve-out: the end was company-attested, nothing was
     * destroyed, and it is within the correction window. On success the relationship
     * returns to 'active' and the still-active consents apply again.
     *
     * The 'reason' is REQUIRED (the correction must carry its justification): a blank
     * one fails CLOSED client-side (AgreelyConfigError) before any wire call. A
     * relationship that is NOT undo-eligible throws AgreelyNotFoundError (404), with
     * nothing written server-side. Never auto-retried (it mutates).
     *
     * @param array{customerRef:string,reason:string} $input
     */
    public function revert(array $input): RelationshipReverted
    {
        $customerRef = trim((string) ($input['customerRef'] ?? ''));
        if ($customerRef === '') {
            throw new AgreelyConfigError('relationships.revert requires a "customerRef".');
        }
        $reason = (string) ($input['reason'] ?? '');
        if (trim($reason) === '') {
            throw new AgreelyConfigError(
                'relationships.revert requires a "reason": the correction of a mistaken end must carry its justification (art. 11 / art. 28).',
            );
        }

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/customers/' . rawurlencode($customerRef) . '/relationship/revert',
            body: ['reason' => $reason],
            idempotentRetry: false,
        ));

        return RelationshipReverted::fromWire($wire);
    }
}
