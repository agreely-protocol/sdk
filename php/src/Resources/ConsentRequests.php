<?php

declare(strict_types=1);

namespace Agreely\Sdk\Resources;

use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Errors\AgreelyRateLimitError;
use Agreely\Sdk\Errors\AgreelyTimeoutError;
use Agreely\Sdk\Http\RequestSpec;
use Agreely\Sdk\Http\Transport;
use Agreely\Sdk\Types\ConsentRequestPage;
use Agreely\Sdk\Types\ConsentRequestRecord;
use Agreely\Sdk\Types\IssuedRequest;
use Generator;

/**
 * The consent-request resource (scope: 'issue'). Keyed throughout on the PROTOCOL
 * requestId (0x + 64hex), never the internal uuid.
 */
final class ConsentRequests
{
    /** The terminal (settled) consent-request statuses. */
    private const TERMINAL_STATUSES = ['approved', 'refused', 'expired', 'revoked_before_action'];

    /** Default guard so an unbounded list can never spin forever. */
    private const DEFAULT_MAX_PAGES = 1000;

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

    /**
     * Auto-paginate over ALL requests as a Generator, looping `nextCursor` for
     * you. Bounded by `maxPages` (default 1000) so a runaway cursor can never spin
     * forever.
     *
     *   foreach ($agreely->consentRequests()->iterate() as $req) { … }
     *
     * @param array{status?:string,cursor?:string,maxPages?:int} $input
     * @return Generator<int, ConsentRequestRecord>
     */
    public function iterate(array $input = []): Generator
    {
        $maxPages = isset($input['maxPages']) && is_int($input['maxPages']) ? $input['maxPages'] : self::DEFAULT_MAX_PAGES;
        $cursor = $input['cursor'] ?? null;
        for ($page = 0; $page < $maxPages; $page++) {
            $listInput = [];
            if (isset($input['status'])) {
                $listInput['status'] = $input['status'];
            }
            if ($cursor !== null) {
                $listInput['cursor'] = $cursor;
            }
            $result = $this->list($listInput);
            foreach ($result->items as $item) {
                yield $item;
            }
            if ($result->nextCursor === null) {
                return;
            }
            $cursor = $result->nextCursor;
        }
    }

    /**
     * Collect {@see iterate} into a single array (convenience).
     *
     * @param array{status?:string,cursor?:string,maxPages?:int} $input
     * @return list<ConsentRequestRecord>
     */
    public function collect(array $input = []): array
    {
        return iterator_to_array($this->iterate($input), false);
    }

    /**
     * Poll GET /v1/consent-requests/{id} until it reaches a terminal state
     * (approved | refused | expired | revoked_before_action), or throw
     * AgreelyTimeoutError when the budget elapses. Honors Retry-After on a 429.
     *
     * @param array{intervalMs?:int,timeoutMs?:int} $opts
     */
    public function waitForSettlement(string $requestId, array $opts = []): ConsentRequestRecord
    {
        $intervalMs = isset($opts['intervalMs']) && is_int($opts['intervalMs']) ? $opts['intervalMs'] : 2000;
        $timeoutMs = isset($opts['timeoutMs']) && is_int($opts['timeoutMs']) ? $opts['timeoutMs'] : 120000;
        $deadline = $this->nowMs() + $timeoutMs;
        $lastStatus = null;

        while (true) {
            try {
                $record = $this->get($requestId);
            } catch (AgreelyRateLimitError $error) {
                $waitMs = ($error->retryAfter ?? (int) ceil($intervalMs / 1000)) * 1000;
                if ($this->nowMs() + $waitMs >= $deadline) {
                    throw new AgreelyTimeoutError(
                        "waitForSettlement timed out after {$timeoutMs}ms while rate-limited.",
                        $lastStatus,
                    );
                }
                usleep($waitMs * 1000);
                continue;
            }

            $lastStatus = $record->status;
            if (in_array($record->status, self::TERMINAL_STATUSES, true)) {
                return $record;
            }

            if ($this->nowMs() + $intervalMs >= $deadline) {
                throw new AgreelyTimeoutError(
                    "waitForSettlement timed out after {$timeoutMs}ms; last status \"{$record->status}\".",
                    $record->status,
                );
            }
            usleep($intervalMs * 1000);
        }
    }

    private function nowMs(): float
    {
        return microtime(true) * 1000;
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
