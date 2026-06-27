<?php

declare(strict_types=1);

namespace Agreely\Sdk\Resources;

use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Http\RequestSpec;
use Agreely\Sdk\Http\Transport;
use Agreely\Sdk\Types\ConsentRequestPage;
use Agreely\Sdk\Types\ConsentRequestRecord;
use Agreely\Sdk\Types\IssuedRequest;

/**
 * The consent-request resource (scope: 'issue'). Keyed throughout on the PROTOCOL
 * requestId (0x + 64hex), never the internal uuid.
 */
final class ConsentRequests
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Issue a consent request. Items are catalog ids and/or raw {category, purpose}
     * pairs — sent RAW, resolved server-side. NEVER auto-retried (it emails): an
     * Idempotency-Key is auto-generated per call (override via
     * $options['idempotencyKey']) so a caller-driven retry replays the original 201
     * byte-for-byte rather than double-issuing.
     *
     * @param array{customerId:string,recipientEmail:string,items:list<string|array{category:string,purpose:string}>,validUntil:string} $input
     * @param array{idempotencyKey?:string} $options
     */
    public function create(array $input, array $options = []): IssuedRequest
    {
        foreach (['customerId', 'recipientEmail', 'items', 'validUntil'] as $required) {
            if (!isset($input[$required])) {
                throw new AgreelyConfigError("consentRequests.create requires \"{$required}\".");
            }
        }

        $idempotencyKey = $options['idempotencyKey'] ?? self::generateIdempotencyKey();

        $wire = $this->transport->request(new RequestSpec(
            method: 'POST',
            path: '/v1/consent-requests',
            body: [
                'customerId' => $input['customerId'],
                'recipientEmail' => $input['recipientEmail'],
                'validUntil' => $input['validUntil'],
                'items' => $input['items'],
            ],
            headers: ['Idempotency-Key' => $idempotencyKey],
            idempotentRetry: false,
        ));

        return IssuedRequest::fromWire($wire);
    }

    /**
     * List the company's requests, newest first, with optional status filter +
     * cursor. The page maps the wire `requests` field to `items`.
     *
     * @param array{status?:string,cursor?:string} $input
     */
    public function list(array $input = []): ConsentRequestPage
    {
        $wire = $this->transport->request(new RequestSpec(
            method: 'GET',
            path: '/v1/consent-requests',
            query: [
                'status' => $input['status'] ?? null,
                'cursor' => $input['cursor'] ?? null,
            ],
            idempotentRetry: true,
        ));
        return ConsentRequestPage::fromWire($wire);
    }

    /** Fetch one request by its protocol requestId (0x + 64hex). */
    public function get(string $requestId): ConsentRequestRecord
    {
        $wire = $this->transport->request(new RequestSpec(
            method: 'GET',
            path: '/v1/consent-requests/' . rawurlencode($requestId),
            idempotentRetry: true,
        ));
        return ConsentRequestRecord::fromWire($wire);
    }

    /** A unique Idempotency-Key per create call (a v4-style uuid). */
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
