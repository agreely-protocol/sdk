<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Test\Support\MockHttpClient;
use Agreely\Sdk\Types\ClaimLink;
use Agreely\Sdk\Types\ManualConsentErasure;
use Agreely\Sdk\Types\ManualConsentResult;
use Agreely\Sdk\Types\ManualConsentRevocation;
use PHPUnit\Framework\TestCase;

final class ManualConsentsTest extends TestCase
{
    private const REF = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    private const SHA = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    private function client(MockHttpClient $http): Agreely
    {
        return new Agreely(['apiKey' => 'k', 'baseUrl' => 'https://api.test', 'httpClient' => $http]);
    }

    /** @return array{customerId:string,documentVersionId:string,effectiveDate:string,validUntil:string,items:list<string|array{category:string,purpose:string}>,evidence:array{pdfSha256:string,pdf?:string}} */
    private function input(): array
    {
        return [
            'customerId' => 'cust',
            'documentVersionId' => 'doc-1',
            'effectiveDate' => '2026-06-01',
            'validUntil' => '2031-01-01',
            'items' => ['0xcat', ['category' => 'Email', 'purpose' => 'News']],
            'evidence' => ['pdfSha256' => self::SHA],
        ];
    }

    private static function recorded(): MockHttpClient
    {
        return new MockHttpClient([
            MockHttpClient::json(201, [
                'consentId' => 'mc_1',
                'merkleRoot' => '0x' . str_repeat('1', 64),
                'consentRefs' => [self::REF],
                'assurance' => 'company_attested',
                'anchored' => false,
            ]),
        ]);
    }

    public function testRecordReturnsTheCompanyAttestedResult(): void
    {
        $http = self::recorded();
        $r = $this->client($http)->manualConsents()->record($this->input());
        $this->assertInstanceOf(ManualConsentResult::class, $r);
        $this->assertSame('company_attested', $r->assurance);
        $this->assertFalse($r->anchored);
        $this->assertSame([self::REF], $r->consentRefs);
        $this->assertSame('/v1/manual-consents', $http->calls[0]->path());
    }

    public function testRecordAutoGeneratesAnIdempotencyKey(): void
    {
        $http = self::recorded();
        $this->client($http)->manualConsents()->record($this->input());
        $key = $http->calls[0]->header('Idempotency-Key');
        $this->assertNotNull($key);
        $this->assertStringStartsWith('idem_', $key);
    }

    public function testRecordAutoKeyIsUniquePerCall(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(201, ['consentId' => 'mc', 'merkleRoot' => '0x', 'consentRefs' => [], 'assurance' => 'company_attested', 'anchored' => false]),
        ]);
        $client = $this->client($http);
        $client->manualConsents()->record($this->input());
        $client->manualConsents()->record($this->input());
        $this->assertNotSame(
            $http->calls[0]->header('Idempotency-Key'),
            $http->calls[1]->header('Idempotency-Key'),
        );
    }

    public function testRecordHonoursAnOverriddenIdempotencyKey(): void
    {
        $http = self::recorded();
        $this->client($http)->manualConsents()->record($this->input(), ['idempotencyKey' => 'order-4471']);
        $this->assertSame('order-4471', $http->calls[0]->header('Idempotency-Key'));
    }

    public function testRecordSendsRawItemsAndTheHashCommitmentWithoutPdfBytes(): void
    {
        $http = self::recorded();
        $this->client($http)->manualConsents()->record($this->input());
        $body = $http->calls[0]->body;
        $this->assertNotNull($body);
        $items = $body['items'];
        $this->assertIsArray($items);
        $this->assertSame('0xcat', $items[0]);
        $this->assertIsArray($items[1]);
        $this->assertSame('Email', $items[1]['category']);
        $evidence = $body['evidence'];
        $this->assertIsArray($evidence);
        $this->assertSame(self::SHA, $evidence['pdfSha256']);
        $this->assertArrayNotHasKey('pdf', $evidence);
    }

    public function testRecordUploadsThePdfBytesOnlyWhenProvided(): void
    {
        $http = self::recorded();
        $input = $this->input();
        $input['evidence']['pdf'] = 'YmFzZTY0';
        $this->client($http)->manualConsents()->record($input);
        $body = $http->calls[0]->body;
        $this->assertNotNull($body);
        $evidence = $body['evidence'];
        $this->assertIsArray($evidence);
        $this->assertSame('YmFzZTY0', $evidence['pdf']);
    }

    public function testCreateClaimLinkReturnsTheLink(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(201, ['claimUrl' => 'https://x/claim/abc', 'token' => 'tok_abc', 'expiresAt' => '2026-07-01T00:00:00Z']),
        ]);
        $link = $this->client($http)->manualConsents()->createClaimLink(['customerId' => 'cust', 'reference' => 'order-99']);
        $this->assertInstanceOf(ClaimLink::class, $link);
        $this->assertSame('tok_abc', $link->token);
        $this->assertSame('/v1/manual-consents/claim-links', $http->calls[0]->path());
        $body = $http->calls[0]->body;
        $this->assertNotNull($body);
        $this->assertSame('cust', $body['customerId']);
        $this->assertSame('order-99', $body['reference']);
    }

    public function testRevokeForwardsReasonAndIsKeyedOnTheConsentRef(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['consentRef' => self::REF, 'revoked' => true, 'alreadyRevoked' => false]),
        ]);
        $r = $this->client($http)->manualConsents()->revoke(self::REF, ['reason' => 'withdrawn']);
        $this->assertInstanceOf(ManualConsentRevocation::class, $r);
        $this->assertTrue($r->revoked);
        $this->assertFalse($r->alreadyRevoked);
        $this->assertSame('/v1/manual-consents/' . self::REF . '/revoke', $http->calls[0]->path());
        $body = $http->calls[0]->body;
        $this->assertNotNull($body);
        $this->assertSame('withdrawn', $body['reason']);
    }

    public function testEraseIsKeyedOnTheConsentRef(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['consentRef' => self::REF, 'erased' => true, 'alreadyErased' => true]),
        ]);
        $r = $this->client($http)->manualConsents()->erase(self::REF);
        $this->assertInstanceOf(ManualConsentErasure::class, $r);
        $this->assertTrue($r->erased);
        $this->assertTrue($r->alreadyErased);
        $this->assertSame('/v1/manual-consents/' . self::REF . '/erase', $http->calls[0]->path());
    }

    public function testCheckResultCarriesAssuranceFromWire(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, [
                'decision' => 'allow',
                'status' => 'active',
                'consentRef' => self::REF,
                'assurance' => 'company_attested',
                'checkedAt' => '2026-01-01T00:00:00Z',
            ]),
        ]);
        $r = $this->client($http)->checkDetailed('c1', 'Email', 'News');
        $this->assertSame('company_attested', $r->assurance);
    }

    public function testCheckResultAssuranceIsNullForStatusNone(): void
    {
        $http = new MockHttpClient([
            MockHttpClient::json(200, ['decision' => 'deny', 'status' => 'none', 'checkedAt' => 't']),
        ]);
        $r = $this->client($http)->checkDetailed('c1', 'Email', 'News');
        $this->assertNull($r->assurance);
    }
}
