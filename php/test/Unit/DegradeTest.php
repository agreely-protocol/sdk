<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Degrade\DegradeContext;
use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Errors\AgreelyUnavailableError;
use Agreely\Sdk\Test\Support\MockHttpClient;
use PHPUnit\Framework\TestCase;

final class DegradeTest extends TestCase
{
    /** @var list<DegradeContext> */
    private array $audited = [];

    protected function setUp(): void
    {
        $this->audited = [];
        putenv('AGREELY_SILENCE_WARNINGS=1'); // keep the one-time warning out of test output
    }

    protected function tearDown(): void
    {
        putenv('AGREELY_SILENCE_WARNINGS');
    }

    private function outage(): MockHttpClient
    {
        // Two 503s so a retried check still ends in an outage.
        return new MockHttpClient([
            MockHttpClient::json(503, ['error' => ['code' => 'unavailable', 'message' => 'down']]),
        ]);
    }

    /** @param array<string,mixed> $extra */
    private function client(MockHttpClient $http, array $extra = []): Agreely
    {
        return new Agreely(array_merge([
            'apiKey' => 'k',
            'baseUrl' => 'https://api.test',
            'httpClient' => $http,
            'timeout' => 400,
        ], $extra));
    }

    /**
     * @param list<string> $categories
     * @return array<string,mixed> a wired fail-open config recording audits
     */
    private function failOpenConfig(array $categories): array
    {
        return [
            'mode' => 'fail-open',
            'categories' => $categories,
            'maxOutageWindow' => '5m',
            'onDegrade' => function (DegradeContext $ctx): void {
                $this->audited[] = $ctx;
            },
        ];
    }

    // ---- fail-closed default ------------------------------------------------

    public function testFailClosedDefaultDeniesOn503(): void
    {
        $this->assertFalse($this->client($this->outage())->check('c', 'Browsing/usage', 'Analytics'));
    }

    public function testFailClosedDefaultCheckDetailedThrows(): void
    {
        $this->expectException(AgreelyUnavailableError::class);
        $this->client($this->outage())->checkDetailed('c', 'Browsing/usage', 'Analytics');
    }

    // ---- two-gate fail-open -------------------------------------------------

    public function testFailOpenAllowsOnlyWhenAllowListedAndOptedIn(): void
    {
        $client = $this->client($this->outage(), ['degradeOnOutage' => $this->failOpenConfig(['Browsing/usage'])]);
        $this->assertTrue($client->check('c', 'Browsing/usage', 'Analytics', ['onOutage' => 'allow']));
        $this->assertCount(1, $this->audited);
        $ctx = $this->audited[0];
        $this->assertSame('fail-open', $ctx->mode);
        $this->assertFalse($ctx->breakGlass);
        $this->assertSame('Browsing/usage', $ctx->category);
        $this->assertInstanceOf(AgreelyUnavailableError::class, $ctx->error);
    }

    public function testFailOpenCheckDetailedReturnsDegradedAllow(): void
    {
        $client = $this->client($this->outage(), ['degradeOnOutage' => $this->failOpenConfig(['Browsing/usage'])]);
        $d = $client->checkDetailed('c', 'Browsing/usage', 'Analytics', ['onOutage' => 'allow']);
        $this->assertSame('allow', $d->decision);
        $this->assertTrue($d->degraded);
        $this->assertSame('fail-open', $d->mode);
        $this->assertNull($d->consentRef);
    }

    public function testGateOneAllowListedButNotOptedInDenies(): void
    {
        $client = $this->client($this->outage(), ['degradeOnOutage' => $this->failOpenConfig(['Browsing/usage'])]);
        $this->assertFalse($client->check('c', 'Browsing/usage', 'Analytics')); // no per-call opt
        $this->assertCount(0, $this->audited);
    }

    public function testGateTwoOptedInButNotAllowListedDenies(): void
    {
        $client = $this->client($this->outage(), ['degradeOnOutage' => $this->failOpenConfig(['Other'])]);
        $this->assertFalse($client->check('c', 'Browsing/usage', 'Analytics', ['onOutage' => 'allow']));
        $this->assertCount(0, $this->audited);
    }

    public function testPerCallOptInWithNoConfigStillDenies(): void
    {
        // No degradeOnOutage config at all: a per-call opt-in is a no-op (still denies).
        $this->assertFalse($this->client($this->outage())->check('c', 'X', 'Y', ['onOutage' => 'allow']));
    }

    public function testAllowListMatchIsWhitespaceAndCaseInsensitiveLocally(): void
    {
        // Local policy key only; the wire still carries the raw category.
        $client = $this->client($this->outage(), ['degradeOnOutage' => $this->failOpenConfig(['Browsing/Usage'])]);
        $this->assertTrue($client->check('c', '  browsing/usage ', 'Analytics', ['onOutage' => 'allow']));
    }

    public function testPerCallDenyForcesFailClosedEvenWhenFailOpenConfigured(): void
    {
        $client = $this->client($this->outage(), ['degradeOnOutage' => $this->failOpenConfig(['Browsing/usage'])]);
        $this->assertFalse($client->check('c', 'Browsing/usage', 'Analytics', ['onOutage' => 'deny']));
        $this->assertCount(0, $this->audited);
    }

    // ---- a 200 deny is NEVER degraded --------------------------------------

    public function test200DenyIsNeverDegradedEvenWithFailOpenAndOpt(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['decision' => 'deny', 'status' => 'revoked', 'consentRef' => '0x1', 'checkedAt' => 'now']),
        ]);
        $client = $this->client($http, ['degradeOnOutage' => $this->failOpenConfig(['Browsing/usage'])]);
        $d = $client->checkDetailed('c', 'Browsing/usage', 'Analytics', ['onOutage' => 'allow']);
        $this->assertSame('deny', $d->decision);
        $this->assertFalse($d->degraded); // a real server deny, untouched by the policy
        $this->assertCount(0, $this->audited);
    }

    // ---- construction validation -------------------------------------------

    public function testMissingOnDegradeThrowsConfigError(): void
    {
        $this->expectException(AgreelyConfigError::class);
        $this->client($this->outage(), ['degradeOnOutage' => [
            'mode' => 'fail-open',
            'categories' => ['X'],
            'maxOutageWindow' => '5m',
        ]]);
    }

    public function testWrongModeThrowsConfigError(): void
    {
        $this->expectException(AgreelyConfigError::class);
        $this->client($this->outage(), ['degradeOnOutage' => [
            'mode' => 'fail-closed',
            'categories' => ['X'],
            'maxOutageWindow' => '5m',
            'onDegrade' => static function (): void {
            },
        ]]);
    }

    public function testMaxOutageWindowOverCapThrowsConfigError(): void
    {
        $this->expectException(AgreelyConfigError::class);
        $this->client($this->outage(), ['degradeOnOutage' => [
            'mode' => 'fail-open',
            'categories' => ['X'],
            'maxOutageWindow' => '9999h', // over the 24h default cap
            'onDegrade' => static function (): void {
            },
        ]]);
    }

    public function testMaxOutageWindowCapOverridableUp(): void
    {
        // Raising the client cap lets a larger window through without throwing.
        $config = array_merge($this->failOpenConfig(['Browsing/usage']), ['maxOutageWindow' => '36h']);
        $client = $this->client($this->outage(), [
            'maxDegradeWindow' => '48h',
            'degradeOnOutage' => $config,
        ]);
        $this->assertTrue($client->check('c', 'Browsing/usage', 'Analytics', ['onOutage' => 'allow']));
    }
}
