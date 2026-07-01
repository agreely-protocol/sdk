<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Contract;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Errors\AgreelyAuthError;
use Agreely\Sdk\Errors\AgreelyNotFoundError;
use Agreely\Sdk\Errors\AgreelyRateLimitError;
use Agreely\Sdk\Errors\AgreelyValidationError;
use PHPUnit\Framework\TestCase;

/**
 * The live E2E contract suite against the running /v1 API on :8081. Gated on a
 * seeded fixture; skips cleanly without the stack. Covers the items the TS
 * contract suite covers so the PHP client behaves identically against the real
 * server: typed-error classification, revoke-then-check instant deny, scope 403,
 * issuance + idempotency replay (no double-issue), tenant scoping, catalog
 * discovery, and a best-effort 429.
 */
final class LiveContractTest extends TestCase
{
    private const REQUEST_ID = '/^0x[0-9a-f]{64}$/';

    private Fixture $fixture;

    protected function setUp(): void
    {
        // Gated behind AGREELY_LIVE=1: this drives the LIVE, stateful, rate-limited
        // /v1 API, so it is OFF by default and the default `phpunit` run stays a
        // deterministic offline green. Run `AGREELY_LIVE=1 phpunit` with the stack up.
        if (getenv('AGREELY_LIVE') !== '1') {
            $this->markTestSkipped('Live contract suite is gated behind AGREELY_LIVE=1 (default run stays offline).');
        }
        if (!Fixture::exists()) {
            $this->markTestSkipped('No fixture. Run `make php-sdk-contract` to seed from the live api.');
        }
        $this->fixture = Fixture::load();
    }

    private function client(string $scope): Agreely
    {
        return new Agreely(['apiKey' => $this->fixture->key($scope), 'baseUrl' => $this->fixture->baseUrl()]);
    }

    public function testIssueOnlyKeyThrowsAuthErrorForbiddenFromCheck(): void
    {
        try {
            $this->client('issue')->checkDetailed($this->fixture->subject(), 'Email Address', 'Marketing Outreach');
            $this->fail('expected AgreelyAuthError (403 forbidden)');
        } catch (AgreelyAuthError $e) {
            $this->assertSame(403, $e->status);
            $this->assertSame('forbidden', $e->code);
        }
    }

    public function testBadKeyThrowsAuthError401(): void
    {
        $bad = new Agreely(['apiKey' => 'agr_live_' . str_repeat('z', 43), 'baseUrl' => $this->fixture->baseUrl()]);
        try {
            $bad->catalog()->list();
            $this->fail('expected AgreelyAuthError (401)');
        } catch (AgreelyAuthError $e) {
            $this->assertSame(401, $e->status);
        }
    }

    public function testEmptyPurposeThrowsValidationErrorNamingTheField(): void
    {
        try {
            $this->client('check')->checkDetailed($this->fixture->subject(), 'Email Address', '');
            $this->fail('expected AgreelyValidationError');
        } catch (AgreelyValidationError $e) {
            $this->assertSame('purpose', $e->field);
        }
    }

    public function testRevokeThenCheckInstantDeny(): void
    {
        $agreely = $this->client('check');
        $r = $this->fixture->revocable();

        // Allows now.
        $this->assertTrue($agreely->check($this->fixture->subject(), $r['category'], $r['purpose']));

        // Flip the enforcement record out-of-band (the M5 revoke path), in-container.
        $repoRoot = dirname(__DIR__, 3);
        exec(
            'cd ' . escapeshellarg($repoRoot)
            . ' && docker compose exec -T api php scripts/sdk-contract-seed.php revoke '
            . escapeshellarg($r['consentRef']) . ' 2>&1',
            $out,
            $code,
        );
        $this->assertSame(0, $code, 'revoke subcommand failed: ' . implode("\n", $out));

        // The very next check denies — no chain wait, no allow-cache (spec §17.9 / §16).
        $after = $agreely->checkDetailed($this->fixture->subject(), $r['category'], $r['purpose']);
        $this->assertSame('deny', $after->decision);
        $this->assertSame('revoked', $after->status);
    }

    public function testTenantIsolation(): void
    {
        $other = $this->client('otherTenantCheck');
        $result = $other->checkDetailed($this->fixture->subject(), 'Email Address', 'Marketing Outreach');
        // Company A granted this (subject, labels); company B did not. A leak shows allow.
        $this->assertSame('deny', $result->decision);
        $this->assertSame('none', $result->status);
    }

    public function testCatalogDiscoveryShape(): void
    {
        $entries = $this->client('both')->catalog()->list();
        $this->assertNotEmpty($entries);
        $ids = array_map(static fn ($e): string => $e->id, $entries);
        $this->assertContains($this->fixture->issue()['catalogId'], $ids);
    }

    public function testIssuanceAndIdempotencyReplayNoDoubleIssue(): void
    {
        $issuer = $this->client('issue');
        $issue = $this->fixture->issue();
        $input = [
            'customerId' => $this->fixture->subject(),
            'recipientEmail' => $issue['recipientEmail'],
            'consentDocumentId' => $issue['documentId'],
            'validUntil' => $issue['validUntil'],
        ];
        $key = 'php-contract-' . bin2hex(random_bytes(6));

        $first = $issuer->consentRequests()->create($input, ['idempotencyKey' => $key]);
        $this->assertMatchesRegularExpression(self::REQUEST_ID, $first->requestId);
        $this->assertSame('pending', $first->status);
        $this->assertSame($issue['documentCode'], $first->document?->code);

        // Same key -> replay the original 201 (no new issue, no second email).
        $replay = $issuer->consentRequests()->create($input, ['idempotencyKey' => $key]);
        $this->assertSame($first->requestId, $replay->requestId);

        // get() by the PROTOCOL requestId (not a uuid).
        $got = $issuer->consentRequests()->get($first->requestId);
        $this->assertSame($first->requestId, $got->requestId);

        // list() surfaces it; the page maps the wire `requests` field to `items`.
        $page = $issuer->consentRequests()->list(['status' => 'pending']);
        $found = array_filter($page->items, static fn ($r): bool => $r->requestId === $first->requestId);
        $this->assertNotEmpty($found);
    }

    public function testDocumentCodeResolvedToThePublishedVersionServerSide(): void
    {
        $issuer = $this->client('issue');
        $issue = $this->fixture->issue();
        $created = $issuer->consentRequests()->create([
            'customerId' => $this->fixture->subject(),
            'recipientEmail' => $issue['recipientEmail'],
            'documentCode' => $issue['documentCode'],
            'validUntil' => $issue['validUntil'],
        ]);
        $this->assertMatchesRegularExpression(self::REQUEST_ID, $created->requestId);
        $this->assertSame($issue['documentCode'], $created->document?->code);
        $this->assertSame($issue['category'], $created->items[0]->category);
        $this->assertSame($issue['purpose'], $created->items[0]->purpose);
    }

    public function testIdentityReturnsLeastDisclosureScopes(): void
    {
        $identity = $this->client('check')->identity();
        $this->assertContains('check', $identity->scopes);
        $this->assertSame($this->fixture->baseUrl(), $identity->baseUrl);

        $issuer = $this->client('issue')->identity();
        $this->assertContains('issue', $issuer->scopes);
    }

    public function testIdentityBadKeyThrowsAuthError401(): void
    {
        $bad = new Agreely(['apiKey' => 'agr_live_' . str_repeat('z', 43), 'baseUrl' => $this->fixture->baseUrl()]);
        try {
            $bad->identity();
            $this->fail('expected AgreelyAuthError (401)');
        } catch (AgreelyAuthError $e) {
            $this->assertSame(401, $e->status);
        }
    }

    public function testCancelPendingThenIdempotentOnTerminal(): void
    {
        $issuer = $this->client('issue');
        $issue = $this->fixture->issue();
        $created = $issuer->consentRequests()->create([
            'customerId' => $this->fixture->subject(),
            'recipientEmail' => $issue['recipientEmail'],
            'items' => [$issue['catalogId']],
            'validUntil' => $issue['validUntil'],
        ]);

        $cancelled = $issuer->consentRequests()->cancel($created->requestId);
        $this->assertSame($created->requestId, $cancelled->requestId);
        $this->assertSame('revoked_before_action', $cancelled->status);
        $this->assertTrue($cancelled->cancelled);

        // Idempotent: a second cancel is not an error and reports cancelled=false.
        $again = $issuer->consentRequests()->cancel($created->requestId);
        $this->assertFalse($again->cancelled);
        $this->assertSame('revoked_before_action', $again->status);
    }

    public function testCancelUnknownRequestThrowsNotFound(): void
    {
        $this->expectException(AgreelyNotFoundError::class);
        $this->client('issue')->consentRequests()->cancel('0x' . str_repeat('a', 64));
    }

    public function testRateLimitClassification429(): void
    {
        // Best-effort: hammer check until a 429 surfaces. If the window is generous
        // and none appears, skip (the unit suite covers the 429 -> RateLimitError
        // mapping deterministically).
        $agreely = $this->client('check');
        for ($i = 0; $i < 400; $i++) {
            try {
                $agreely->checkDetailed($this->fixture->subject(), 'Email Address', 'Marketing Outreach');
            } catch (AgreelyRateLimitError $e) {
                $this->assertSame(429, $e->status);
                $this->assertSame('rate_limited', $e->code);
                return;
            }
        }
        $this->markTestSkipped('No 429 within 400 requests; rate window too generous to trigger here.');
    }
}
