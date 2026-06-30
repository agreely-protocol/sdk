<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Contract;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Types\Wire;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * THE cross-SDK anti-drift gate. Loads the SHARED golden vectors
 * (../../vectors/vectors.json — the very file the TS SDK asserts) and drives
 * the PHP SDK against the LIVE /v1 API, asserting the SAME decision / status /
 * consentRef-presence and the SAME typed error per vector that the TS SDK does.
 * If the contract drifts, BOTH SDKs fail on this file.
 *
 * Gated on a seeded fixture (test/Contract/fixture.json); skips cleanly without
 * the stack (CI without docker), exactly like the TS contract suite.
 */
final class GoldenVectorParityTest extends TestCase
{
    private const REQUEST_ID = '/^0x[0-9a-f]{64}$/';
    private const CONSENT_REF = '/^0x[0-9a-f]+$/';

    private static function golden(): string
    {
        return dirname(__DIR__, 3) . '/vectors/vectors.json';
    }

    protected function setUp(): void
    {
        if (!Fixture::exists()) {
            $this->markTestSkipped('No fixture. Run `make php-sdk-contract` to seed from the live api.');
        }
    }

    /**
     * @return array<string,mixed>
     */
    private static function vectors(): array
    {
        /** @var array<string,mixed> $data */
        $data = json_decode((string) file_get_contents(self::golden()), true);
        return $data;
    }

    /**
     * @return iterable<string,array{0:array<string,mixed>}>
     */
    public static function checkVectors(): iterable
    {
        if (!Fixture::exists()) {
            yield 'skipped (no fixture)' => [['name' => 'skipped']];
            return;
        }
        /** @var list<array<string,mixed>> $checks */
        $checks = self::vectors()['checks'];
        foreach ($checks as $vec) {
            yield Wire::str($vec['name']) => [$vec];
        }
    }

    /**
     * @return iterable<string,array{0:array<string,mixed>}>
     */
    public static function errorVectors(): iterable
    {
        if (!Fixture::exists()) {
            yield 'skipped (no fixture)' => [['name' => 'skipped']];
            return;
        }
        /** @var list<array<string,mixed>> $errors */
        $errors = self::vectors()['errors'];
        foreach ($errors as $vec) {
            yield Wire::str($vec['name']) => [$vec];
        }
    }

    /**
     * @param array<string,mixed> $vec
     */
    #[DataProvider('checkVectors')]
    public function testCheckVectorMatchesTheContract(array $vec): void
    {
        $fixture = Fixture::load();
        $agreely = new Agreely(['apiKey' => $fixture->key('check'), 'baseUrl' => $fixture->baseUrl()]);

        /** @var array{decision:string,status:string,consentRefPresent:bool} $expect */
        $expect = $vec['expect'];
        $customerId = $vec['subject'] === 'active' ? $fixture->subject() : $fixture->absent();
        $category = Wire::str($vec['category']);
        $purpose = Wire::str($vec['purpose']);

        $result = $agreely->checkDetailed($customerId, $category, $purpose);

        $this->assertSame($expect['decision'], $result->decision, 'decision drift');
        $this->assertSame($expect['status'], $result->status, 'status drift');
        if ($expect['consentRefPresent']) {
            $this->assertNotNull($result->consentRef);
            $this->assertMatchesRegularExpression(self::CONSENT_REF, $result->consentRef);
        } else {
            $this->assertNull($result->consentRef, 'consentRef must be absent for status none');
        }
        $this->assertFalse($result->degraded, 'a live decision is never degraded');

        // The boolean gate agrees with the decision (allow is the only true).
        $this->assertSame(
            $expect['decision'] === 'allow',
            $agreely->check($customerId, $category, $purpose),
        );
    }

    /**
     * @param array<string,mixed> $vec
     */
    #[DataProvider('errorVectors')]
    public function testErrorVectorMatchesTheContract(array $vec): void
    {
        $fixture = Fixture::load();
        /** @var array{status:int,code:string,field?:string} $expect */
        $expect = $vec['expect'];

        $scope = Wire::str($vec['scope']);
        $token = $scope === 'bad' ? 'agr_live_' . str_repeat('z', 43) : $fixture->key($scope);

        // Assert the raw wire envelope { error: { code, message, field? } }.
        $url = $fixture->baseUrl() . Wire::str($vec['path']);
        assert($url !== '');
        $method = Wire::str($vec['method']);
        assert($method !== '');
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS => (string) json_encode($vec['body']),
            CURLOPT_RETURNTRANSFER => true,
        ]);
        $body = (string) curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        $this->assertSame($expect['status'], $status, 'HTTP status drift');
        /** @var array{error:array{code:string,message:string,field?:string}} $payload */
        $payload = json_decode($body, true);
        $this->assertArrayHasKey('error', $payload);
        $this->assertSame($expect['code'], $payload['error']['code'], 'error code drift');
        if (isset($expect['field'])) {
            $this->assertSame($expect['field'], $payload['error']['field'] ?? null, 'error field drift');
        }
    }

    public function testCatalogIdShapeIsProtocolRequestId(): void
    {
        // A sanity check the regex used for parity matches a real protocol id form.
        $this->assertMatchesRegularExpression(self::REQUEST_ID, '0x' . str_repeat('a', 64));
    }
}
