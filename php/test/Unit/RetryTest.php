<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Errors\AgreelyUnavailableError;
use Agreely\Sdk\Test\Support\MockHttpClient;
use PHPUnit\Framework\TestCase;

final class RetryTest extends TestCase
{
    private function client(MockHttpClient $http): Agreely
    {
        return new Agreely(['apiKey' => 'k', 'baseUrl' => 'https://api.test', 'httpClient' => $http, 'timeout' => 800]);
    }

    public function testCheckRetriesOnceOn503ThenSucceeds(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(503, ['error' => ['code' => 'unavailable', 'message' => 'down']]),
            MockHttpClient::json(200, ['decision' => 'allow', 'status' => 'active', 'consentRef' => '0x1', 'checkedAt' => 'now']),
        ]);
        $this->assertTrue($this->client($http)->check('c', 'a', 'b'));
        $this->assertCount(2, $http->calls); // one retry
    }

    public function testCheckRetriesOnNetworkErrorThenSucceeds(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::network(),
            MockHttpClient::json(200, ['decision' => 'deny', 'status' => 'none', 'checkedAt' => 'now']),
        ]);
        $this->assertFalse($this->client($http)->check('c', 'a', 'b'));
        $this->assertCount(2, $http->calls);
    }

    public function testCheckRetryCappedAtTwoAttempts(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(503, ['error' => ['code' => 'unavailable', 'message' => 'down']]),
            MockHttpClient::json(503, ['error' => ['code' => 'unavailable', 'message' => 'down']]),
            MockHttpClient::json(503, ['error' => ['code' => 'unavailable', 'message' => 'down']]),
        ]);
        // Fail-closed default -> check() returns false after exhausting 2 attempts.
        $this->assertFalse($this->client($http)->check('c', 'a', 'b'));
        $this->assertCount(2, $http->calls);
    }

    public function testCreateIsNeverRetried(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(503, ['error' => ['code' => 'unavailable', 'message' => 'down']]),
            MockHttpClient::json(201, ['requestId' => '0x' . str_repeat('a', 64)]),
        ]);
        try {
            $this->client($http)->consentRequests()->create([
                'customerId' => 'c',
                'recipientEmail' => 'r@e.com',
                'consentDocumentId' => '6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
                'validUntil' => '2031-01-01',
            ]);
            $this->fail('expected the outage to surface (create is never retried)');
        } catch (AgreelyUnavailableError) {
            // Exactly one attempt — a create that emails must NOT be auto-retried.
            $this->assertCount(1, $http->calls);
        }
    }

    public function testValidationErrorIsNotRetried(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(422, ['error' => ['code' => 'invalid_request', 'message' => 'bad', 'field' => 'purpose']]),
            MockHttpClient::json(200, ['decision' => 'allow', 'status' => 'active', 'consentRef' => '0x1', 'checkedAt' => 'now']),
        ]);
        try {
            $this->client($http)->check('c', 'a', 'b');
            $this->fail('expected validation error');
        } catch (\Agreely\Sdk\Errors\AgreelyValidationError) {
            $this->assertCount(1, $http->calls); // 4xx is terminal, not transient
        }
    }
}
