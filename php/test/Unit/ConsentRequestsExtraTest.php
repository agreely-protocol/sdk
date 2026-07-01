<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Errors\AgreelyRateLimitError;
use Agreely\Sdk\Errors\AgreelyTimeoutError;
use Agreely\Sdk\Http\RawResponse;
use Agreely\Sdk\Test\Support\MockHttpClient;
use PHPUnit\Framework\TestCase;

/** iterate/collect auto-pagination, waitForSettlement, and rate-limit surfacing. */
final class ConsentRequestsExtraTest extends TestCase
{
    /** @param array<string,mixed> $extra */
    private function client(MockHttpClient $http, array $extra = []): Agreely
    {
        return new Agreely(['apiKey' => 'agr_live_test', 'timeout' => 5000, 'httpClient' => $http, ...$extra]);
    }

    /** @return array<string,mixed> */
    private function rec(string $id, string $status = 'pending'): array
    {
        return [
            'requestId' => $id,
            'status' => $status,
            'validUntil' => '2031-01-01T00:00:00Z',
            'expiresAt' => '2031-01-01T00:00:00Z',
            'createdAt' => '2026-01-01T00:00:00Z',
            'settledAt' => null,
            'items' => [],
        ];
    }

    public function testCollectLoopsNextCursorToExhaustion(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['requests' => [$this->rec('0xa'), $this->rec('0xb')], 'nextCursor' => '0xb']),
            MockHttpClient::json(200, ['requests' => [$this->rec('0xc')], 'nextCursor' => null]),
        ]);
        $all = $this->client($http)->consentRequests()->collect();
        $this->assertSame(['0xa', '0xb', '0xc'], array_map(static fn ($r) => $r->requestId, $all));
        $this->assertCount(2, $http->calls);
        $this->assertStringContainsString('cursor=0xb', $http->calls[1]->query());
    }

    public function testCollectHonorsTheMaxPagesGuard(): void
    {
        $rec = $this->rec('0xloop');
        // A page that always returns a next cursor — the guard must stop it.
        $page = MockHttpClient::json(200, ['requests' => [$rec], 'nextCursor' => '0xnext']);
        $http = new MockHttpClient([static fn (): RawResponse => $page]);
        $all = $this->client($http)->consentRequests()->collect(['maxPages' => 3]);
        $this->assertCount(3, $all);
        $this->assertCount(3, $http->calls);
    }

    public function testWaitForSettlementResolvesOnTerminalState(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, $this->rec('0xr', 'pending')),
            MockHttpClient::json(200, $this->rec('0xr', 'approved')),
        ]);
        $settled = $this->client($http)->consentRequests()->waitForSettlement('0xr', ['intervalMs' => 1, 'timeoutMs' => 1000]);
        $this->assertSame('approved', $settled->status);
    }

    public function testWaitForSettlementThrowsTimeoutWithLastStatus(): void
    {
        $pending = MockHttpClient::json(200, $this->rec('0xr', 'pending'));
        $http = new MockHttpClient([static fn (): RawResponse => $pending]);
        try {
            $this->client($http)->consentRequests()->waitForSettlement('0xr', ['intervalMs' => 5, 'timeoutMs' => 12]);
            $this->fail('expected AgreelyTimeoutError');
        } catch (AgreelyTimeoutError $e) {
            $this->assertSame('pending', $e->lastStatus);
        }
    }

    public function testRateLimitErrorSurfacesRetryAfterSeconds(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(429, ['error' => ['code' => 'rate_limited', 'message' => 'slow down']], ['Retry-After' => 7]),
        ]);
        try {
            $this->client($http)->consentRequests()->get('0xr');
            $this->fail('expected AgreelyRateLimitError');
        } catch (AgreelyRateLimitError $e) {
            $this->assertSame(7, $e->retryAfter);
            $this->assertSame(7, $e->retryAfterSeconds);
        }
    }

    public function testMaxRetriesRetriesAnIdempotentGetAfter429(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(429, ['error' => ['code' => 'rate_limited', 'message' => 'slow']], ['Retry-After' => 0]),
            MockHttpClient::json(200, $this->rec('0xr', 'approved')),
        ]);
        $rec = $this->client($http, ['maxRetries' => 2])->consentRequests()->get('0xr');
        $this->assertSame('approved', $rec->status);
        $this->assertCount(2, $http->calls);
    }
}
