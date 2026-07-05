<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Types\BatchCheckItem;
use Agreely\Sdk\Types\BatchDecision;
use Agreely\Sdk\Types\CheckFieldsResult;
use Agreely\Sdk\Test\Support\MockHttpClient;
use PHPUnit\Framework\TestCase;

final class CheckBatchTest extends TestCase
{
    private function client(MockHttpClient $http): Agreely
    {
        return new Agreely([
            'apiKey'     => 'agr_live_test',
            'baseUrl'    => 'https://api.test',
            'httpClient' => $http,
        ]);
    }

    // ------------------------------------------------------------------
    // checkBatch
    // ------------------------------------------------------------------

    public function testCheckBatchPostsToCorrectEndpointAndReturnsDecisions(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, [
                'decisions' => [
                    ['customerRef' => 'c1', 'category' => 'Email', 'purpose' => 'Marketing',
                     'decision' => 'allow', 'status' => 'active', 'consentRef' => '0xabc', 'checkedAt' => '2026-01-01T00:00:00Z'],
                    ['customerRef' => 'c2', 'category' => 'Phone', 'purpose' => 'Billing',
                     'decision' => 'deny', 'status' => 'none', 'checkedAt' => '2026-01-01T00:00:00Z'],
                ],
            ]),
        ]);
        $items = [
            new BatchCheckItem('c1', 'Email', 'Marketing'),
            new BatchCheckItem('c2', 'Phone', 'Billing'),
        ];
        $decisions = $this->client($http)->checkBatch($items);
        $this->assertCount(2, $decisions);
        $this->assertInstanceOf(BatchDecision::class, $decisions[0]);
        $this->assertSame('allow', $decisions[0]->decision);
        $this->assertSame('active', $decisions[0]->status);
        $this->assertSame('0xabc', $decisions[0]->consentRef);
        $this->assertSame('deny', $decisions[1]->decision);
        $this->assertSame('none', $decisions[1]->status);
        $this->assertNull($decisions[1]->consentRef);

        $call = $http->calls[0];
        $this->assertSame('POST', $call->method);
        $this->assertSame('/v1/check/batch', $call->path());
        $this->assertSame('Bearer agr_live_test', $call->header('Authorization'));
        $this->assertNotNull($call->body);
        $this->assertCount(2, $call->body['items']);
    }

    public function testCheckBatchSendsRawCategoryAndPurpose(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['decisions' => []]),
        ]);
        $this->client($http)->checkBatch([
            new BatchCheckItem('c1', '  Email   ADDRESS ', "Marketing\tOutreach"),
        ]);
        $call = $http->calls[0];
        $this->assertNotNull($call->body);
        $this->assertSame('  Email   ADDRESS ', $call->body['items'][0]['category']);
        $this->assertSame("Marketing\tOutreach", $call->body['items'][0]['purpose']);
    }

    public function testCheckBatchAcceptsBothBatchCheckItemAndArray(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['decisions' => []]),
        ]);
        $this->client($http)->checkBatch([
            new BatchCheckItem('c1', 'Email', 'Marketing'),
            ['customerRef' => 'c2', 'category' => 'Phone', 'purpose' => 'Billing'],
        ]);
        $call = $http->calls[0];
        $this->assertNotNull($call->body);
        $this->assertCount(2, $call->body['items']);
    }

    public function testEmptyBatchShortCircuitsWithoutHttpCall(): void
    {
        $http = new MockHttpClient([]);
        $this->assertCount(0, $this->client($http)->checkBatch([]));
        $this->assertCount(0, $http->calls);
    }

    // ------------------------------------------------------------------
    // checkFields
    // ------------------------------------------------------------------

    public function testCheckFieldsBuildsCartesianProductAndCallsOnce(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, [
                'decisions' => [
                    ['customerRef' => 'c1', 'category' => 'Email', 'purpose' => 'Marketing', 'decision' => 'allow', 'status' => 'active', 'checkedAt' => 't'],
                    ['customerRef' => 'c1', 'category' => 'Phone', 'purpose' => 'Billing', 'decision' => 'deny', 'status' => 'none', 'checkedAt' => 't'],
                    ['customerRef' => 'c2', 'category' => 'Email', 'purpose' => 'Marketing', 'decision' => 'deny', 'status' => 'none', 'checkedAt' => 't'],
                    ['customerRef' => 'c2', 'category' => 'Phone', 'purpose' => 'Billing', 'decision' => 'allow', 'status' => 'active', 'checkedAt' => 't'],
                ],
            ]),
        ]);
        $result = $this->client($http)->checkFields(
            ['c1', 'c2'],
            [['category' => 'Email', 'purpose' => 'Marketing'], ['category' => 'Phone', 'purpose' => 'Billing']],
        );
        $this->assertInstanceOf(CheckFieldsResult::class, $result);
        $this->assertCount(1, $http->calls); // ONE round-trip
        $this->assertCount(4, $result->decisions);
        $this->assertTrue($result->isAllowed('c1', 'Email', 'Marketing'));
        $this->assertFalse($result->isAllowed('c1', 'Phone', 'Billing'));
        $this->assertFalse($result->isAllowed('c2', 'Email', 'Marketing'));
        $this->assertTrue($result->isAllowed('c2', 'Phone', 'Billing'));
    }

    public function testIsAllowedReturnsFalseForUnknownTriple(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, [
                'decisions' => [
                    ['customerRef' => 'c1', 'category' => 'Email', 'purpose' => 'Marketing', 'decision' => 'allow', 'status' => 'active', 'checkedAt' => 't'],
                ],
            ]),
        ]);
        $result = $this->client($http)->checkFields(['c1'], [['category' => 'Email', 'purpose' => 'Marketing']]);
        $this->assertFalse($result->isAllowed('unknown', 'Email', 'Marketing'));
        $this->assertFalse($result->isAllowed('c1', 'Other', 'Marketing'));
    }
}
