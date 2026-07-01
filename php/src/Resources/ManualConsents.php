<?php

declare(strict_types=1);

namespace Agreely\Sdk\Resources;

use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Http\RequestSpec;
use Agreely\Sdk\Http\Transport;
use Agreely\Sdk\Types\ClaimLink;
use Agreely\Sdk\Types\ManualConsentErasure;
use Agreely\Sdk\Types\ManualConsentResult;
use Agreely\Sdk\Types\ManualConsentRevocation;

/**
 * The manual / offline (company-attested) consent resource (scope: 'attest'). The
 * company records a consent it gathered out of band and attests to it under its
 * own name; the resulting enforcement records carry assurance "company_attested".
 * Keyed throughout on the protocol consentRef (0x-hex), never an internal uuid.
 */
final class ManualConsents
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Record a company-attested consent. Items are catalog ids and/or raw
     * {category, purpose} pairs, sent RAW and resolved server-side. Evidence ALWAYS
     * carries the pdfSha256 commitment ("0x" + 64 hex); the pdf bytes (base64) are
     * uploaded only when explicitly provided. NEVER auto-retried (it mutates).
     *
     * IDEMPOTENCY CAVEAT: an Idempotency-Key is auto-generated per call (override
     * via $options['idempotencyKey']) and sent, but the server does NOT yet honor
     * it for POST /v1/manual-consents (unlike consentRequests()->create). A
     * retried record CAN therefore create a DUPLICATE company-attested consent;
     * guard against duplicate submits yourself.
     *
     * @param array{
     *     customerId:string,
     *     documentVersionId:string,
     *     effectiveDate:string,
     *     validUntil:string,
     *     items:list<string|array{category:string,purpose:string}>,
     *     evidence:array{pdfSha256:string,pdf?:string}
     * } $input
     * @param array{idempotencyKey?:string} $options
     */
    public function record(array $input, array $options = []): ManualConsentResult
    {
        foreach (['customerId', 'documentVersionId', 'effectiveDate', 'validUntil', 'items', 'evidence'] as $required) {
            if (!isset($input[$required])) {
                throw new AgreelyConfigError("manualConsents.record requires \"{$required}\".");
            }
        }
        $evidence = $input['evidence'];
        if (!is_array($evidence) || !isset($evidence['pdfSha256'])) {
            throw new AgreelyConfigError('manualConsents.record requires "evidence.pdfSha256".');
        }

        $wireEvidence = ['pdfSha256' => $evidence['pdfSha256']];
        if (isset($evidence['pdf'])) {
            $wireEvidence['pdf'] = $evidence['pdf'];
        }

        $idempotencyKey = $options['idempotencyKey'] ?? self::generateIdempotencyKey();

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/manual-consents',
            body: [
                'customerId' => $input['customerId'],
                'documentVersionId' => $input['documentVersionId'],
                'effectiveDate' => $input['effectiveDate'],
                'validUntil' => $input['validUntil'],
                'items' => $input['items'],
                'evidence' => $wireEvidence,
            ],
            headers: ['Idempotency-Key' => $idempotencyKey],
            idempotentRetry: false,
        ));

        return ManualConsentResult::fromWire($wire);
    }

    /**
     * Create a claim link the company hands to the subject so they can self-claim
     * the recorded attestation. Mutates (mints a token); never auto-retried.
     *
     * @param array{customerId:string,reference?:string} $input
     */
    public function createClaimLink(array $input): ClaimLink
    {
        if (!isset($input['customerId'])) {
            throw new AgreelyConfigError('manualConsents.createClaimLink requires "customerId".');
        }

        $body = ['customerId' => $input['customerId']];
        if (isset($input['reference'])) {
            $body['reference'] = $input['reference'];
        }

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/manual-consents/claim-links',
            body: $body,
            idempotentRetry: false,
        ));

        return ClaimLink::fromWire($wire);
    }

    /**
     * Revoke a manual consent by its protocol consentRef (0x-hex). Idempotent
     * server-side; never auto-retried.
     *
     * @param array{reason?:string} $input
     */
    public function revoke(string $consentRef, array $input = []): ManualConsentRevocation
    {
        $body = [];
        if (isset($input['reason'])) {
            $body['reason'] = $input['reason'];
        }

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/manual-consents/' . rawurlencode($consentRef) . '/revoke',
            body: $body === [] ? null : $body,
            idempotentRetry: false,
        ));

        return ManualConsentRevocation::fromWire($wire);
    }

    /**
     * Erase a manual consent by its protocol consentRef (0x-hex). Idempotent
     * server-side; never auto-retried.
     *
     * @param array{reason?:string} $input
     */
    public function erase(string $consentRef, array $input = []): ManualConsentErasure
    {
        $body = [];
        if (isset($input['reason'])) {
            $body['reason'] = $input['reason'];
        }

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/manual-consents/' . rawurlencode($consentRef) . '/erase',
            body: $body === [] ? null : $body,
            idempotentRetry: false,
        ));

        return ManualConsentErasure::fromWire($wire);
    }

    /** A unique Idempotency-Key per record call (a v4-style uuid). */
    private static function generateIdempotencyKey(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return sprintf(
            'idem_%s-%s-%s-%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 12, 4),
            substr($hex, 16, 4),
            substr($hex, 20, 12),
        );
    }
}
