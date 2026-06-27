<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Errors\AgreelyAuthError;
use Agreely\Sdk\Errors\AgreelyNotFoundError;
use Agreely\Sdk\Errors\AgreelyRateLimitError;
use Agreely\Sdk\Errors\AgreelyUnavailableError;
use Agreely\Sdk\Errors\AgreelyValidationError;
use Agreely\Sdk\Test\Support\MockHttpClient;
use PHPUnit\Framework\TestCase;

final class ErrorsTest extends TestCase
{
    private function client(MockHttpClient $http): Agreely
    {
        return new Agreely(['apiKey' => 'k', 'baseUrl' => 'https://api.test', 'httpClient' => $http]);
    }

    private function err(int $status, string $code, ?string $field = null): MockHttpClient
    {
        $error = ['code' => $code, 'message' => 'boom'];
        if ($field !== null) {
            $error['field'] = $field;
        }
        return new MockHttpClient([MockHttpClient::json($status, ['error' => $error])]);
    }

    public function test401IsAuthError(): void
    {
        $this->expectException(AgreelyAuthError::class);
        $this->client($this->err(401, 'unauthorized'))->checkDetailed('c', 'a', 'b');
    }

    public function test403IsAuthError(): void
    {
        try {
            $this->client($this->err(403, 'forbidden'))->checkDetailed('c', 'a', 'b');
            $this->fail('expected AgreelyAuthError');
        } catch (AgreelyAuthError $e) {
            $this->assertSame('forbidden', $e->code);
            $this->assertSame(403, $e->status);
        }
    }

    public function test400IsValidationError(): void
    {
        $this->expectException(AgreelyValidationError::class);
        $this->client($this->err(400, 'invalid_request'))->checkDetailed('c', 'a', 'b');
    }

    public function test422ValidationErrorCarriesField(): void
    {
        try {
            $this->client($this->err(422, 'invalid_request', 'purpose'))->checkDetailed('c', 'a', '');
            $this->fail('expected AgreelyValidationError');
        } catch (AgreelyValidationError $e) {
            $this->assertSame('purpose', $e->field);
            $this->assertSame(422, $e->status);
        }
    }

    public function test404IsNotFoundError(): void
    {
        $this->expectException(AgreelyNotFoundError::class);
        $this->client($this->err(404, 'not_found'))->consentRequests()->get('0xabc');
    }

    public function test429IsRateLimitErrorWithRetryAfter(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(429, ['error' => ['code' => 'rate_limited', 'message' => 'slow down']], ['Retry-After' => '7']),
        ]);
        try {
            $this->client($http)->checkDetailed('c', 'a', 'b');
            $this->fail('expected AgreelyRateLimitError');
        } catch (AgreelyRateLimitError $e) {
            $this->assertSame(7, $e->retryAfter);
            $this->assertSame(429, $e->status);
        }
    }

    public function test503IsUnavailableError(): void
    {
        try {
            $this->client($this->err(503, 'unavailable'))->checkDetailed('c', 'a', 'b');
            $this->fail('expected AgreelyUnavailableError');
        } catch (AgreelyUnavailableError $e) {
            $this->assertTrue($e->retryable);
            $this->assertSame(503, $e->status);
        }
    }

    public function testNetworkErrorIsUnavailableError(): void
    {
        $http = new MockHttpClient([MockHttpClient::network()]);
        $this->expectException(AgreelyUnavailableError::class);
        $this->client($http)->checkDetailed('c', 'a', 'b');
    }

    public function testTimeoutIsUnavailableError(): void
    {
        $http = new MockHttpClient([MockHttpClient::timeout()]);
        $this->expectException(AgreelyUnavailableError::class);
        $this->client($http)->checkDetailed('c', 'a', 'b');
    }

    public function testNonUnavailableErrorsPropagateFromCheck(): void
    {
        // check() swallows only outages; a 401 must still surface as a throw.
        $this->expectException(AgreelyAuthError::class);
        $this->client($this->err(401, 'unauthorized'))->check('c', 'a', 'b');
    }
}
