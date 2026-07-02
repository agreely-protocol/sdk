<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Errors\AgreelyAuthError;
use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Errors\AgreelyNotFoundError;
use Agreely\Sdk\Errors\AgreelyValidationError;
use Agreely\Sdk\Test\Support\MockHttpClient;
use Agreely\Sdk\Types\RelationshipEnded;
use PHPUnit\Framework\TestCase;

/**
 * relationships()->end (scope: 'relationship') — behaviour parity with the TS
 * relationships.end: the customer-scoped POST, the terminal ended body, the
 * REQUIRED-reason fail-closed guard, and the 403 / 422 / 404 surfacing.
 */
final class RelationshipsTest extends TestCase
{
    private function client(MockHttpClient $http): Agreely
    {
        return new Agreely(['apiKey' => 'k', 'baseUrl' => 'https://api.test', 'httpClient' => $http]);
    }

    private static function ended(): MockHttpClient
    {
        return new MockHttpClient([
            MockHttpClient::json(200, [
                'customerRef' => 'cust-1',
                'status' => 'ended',
                'endedAt' => '2026-07-02T10:00:00Z',
                'endedBy' => 'company',
            ]),
        ]);
    }

    public function testEndPostsReasonToTheCustomerScopedPathAndReturnsTheEndedRelationship(): void
    {
        $http = self::ended();
        $r = $this->client($http)->relationships()->end(['customerRef' => 'cust-1', 'reason' => 'purposes accomplished']);
        $this->assertInstanceOf(RelationshipEnded::class, $r);
        $this->assertSame('ended', $r->status);
        $this->assertSame('company', $r->endedBy);
        $this->assertSame('2026-07-02T10:00:00Z', $r->endedAt);
        $this->assertSame('/v1/customers/cust-1/relationship/end', $http->calls[0]->path());
        $body = $http->calls[0]->body;
        $this->assertNotNull($body);
        $this->assertSame('purposes accomplished', $body['reason']);
    }

    public function testEndPercentEncodesARefWithASlash(): void
    {
        $http = self::ended();
        $this->client($http)->relationships()->end(['customerRef' => 'STORE/0042', 'reason' => 'done']);
        $this->assertSame('/v1/customers/STORE%2F0042/relationship/end', $http->calls[0]->path());
    }

    public function testEndPreservesTheCitizenRequestOriginFromWire(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, [
                'customerRef' => 'cust-1', 'status' => 'ended', 'endedAt' => '2026-07-02T10:00:00Z', 'endedBy' => 'citizen_request',
            ]),
        ]);
        $r = $this->client($http)->relationships()->end(['customerRef' => 'cust-1', 'reason' => 'closing the file']);
        $this->assertSame('citizen_request', $r->endedBy);
    }

    public function testEndFailsClosedOnABlankReasonBeforeAnyWireCall(): void
    {
        $http = self::ended();
        try {
            $this->client($http)->relationships()->end(['customerRef' => 'cust-1', 'reason' => '   ']);
            $this->fail('Expected an AgreelyConfigError.');
        } catch (AgreelyConfigError) {
            $this->assertCount(0, $http->calls, 'A blank reason must never reach the wire.');
        }
    }

    public function testEndFailsClosedOnAMissingCustomerRef(): void
    {
        $http = self::ended();
        $this->expectException(AgreelyConfigError::class);
        $this->client($http)->relationships()->end(['customerRef' => '  ', 'reason' => 'done']);
    }

    public function testEndSurfacesA403MissingScopeAsAuthError(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(403, ['error' => ['code' => 'forbidden', 'message' => "This API key does not carry the 'relationship' scope."]]),
        ]);
        $this->expectException(AgreelyAuthError::class);
        $this->client($http)->relationships()->end(['customerRef' => 'cust-1', 'reason' => 'done']);
    }

    public function testEndSurfacesAServer422AsValidationError(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(422, ['error' => ['code' => 'invalid_request', 'message' => 'reason is required.', 'field' => 'reason']]),
        ]);
        $this->expectException(AgreelyValidationError::class);
        $this->client($http)->relationships()->end(['customerRef' => 'cust-1', 'reason' => 'x']);
    }

    public function testEndMapsAnUnknownOrForeignRefTo404NotFound(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(404, ['error' => ['code' => 'not_found', 'message' => 'No customer with that reference.']]),
        ]);
        $this->expectException(AgreelyNotFoundError::class);
        $this->client($http)->relationships()->end(['customerRef' => 'ghost', 'reason' => 'done']);
    }
}
