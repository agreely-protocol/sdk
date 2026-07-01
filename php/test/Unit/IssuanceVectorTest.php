<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Test\Support\MockHttpClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * ISSUANCE-envelope golden vectors (shared with the TS suite via
 * vectors/vectors.json): consentRequests.create must send EXACTLY one of
 * consentDocumentId / documentCode, never a caller-supplied `items` list, and
 * fail client-side (config error, nothing sent) on zero or two references.
 */
final class IssuanceVectorTest extends TestCase
{
    /** @return array<string,mixed> */
    private static function golden(): array
    {
        $data = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/vectors/vectors.json'), true);
        self::assertIsArray($data);
        self::assertArrayHasKey('issuanceRequest', $data, 'vectors.json must carry the issuanceRequest section.');
        return $data['issuanceRequest'];
    }

    /** @return iterable<string, array{0: array<string,mixed>, 1: array<string,mixed>}> */
    public static function cases(): iterable
    {
        $golden = self::golden();
        foreach ($golden['cases'] as $case) {
            yield $case['name'] => [$golden, $case];
        }
    }

    /**
     * @param array<string,mixed> $golden
     * @param array<string,mixed> $case
     * @return array<string,mixed>
     */
    private function buildInput(array $golden, array $case): array
    {
        $input = $golden['base'];
        if (in_array('consentDocumentId', $case['use'], true)) {
            $input['consentDocumentId'] = $golden['consentDocumentId'];
        }
        if (in_array('documentCode', $case['use'], true)) {
            $input['documentCode'] = $golden['documentCode'];
        }
        // The wire envelope must DROP a caller-supplied items list (items
        // derive from the document server-side).
        if ($case['includeItems']) {
            $input['items'] = $golden['rejectedItems'];
        }
        return $input;
    }

    /**
     * @param array<string,mixed> $golden
     * @param array<string,mixed> $case
     */
    #[DataProvider('cases')]
    public function testIssuanceEnvelopeMatchesTheGoldenVector(array $golden, array $case): void
    {
        $issued = [
            'requestId' => '0x' . str_repeat('ab', 32),
            'status' => 'pending',
            'deepLink' => 'https://x',
            'emailDelivered' => true,
            'items' => [],
            'document' => null,
        ];
        $http = new MockHttpClient([MockHttpClient::json(201, $issued)]);
        $agreely = new Agreely(['apiKey' => 'agr_live_test', 'timeout' => 5000, 'httpClient' => $http]);

        if (($case['expect']['error'] ?? null) === 'config') {
            try {
                $agreely->consentRequests()->create($this->buildInput($golden, $case));
                $this->fail('Expected AgreelyConfigError.');
            } catch (AgreelyConfigError) {
                // expected
            }
            $this->assertCount(0, $http->calls, 'Failed client-side: nothing was sent.');
            return;
        }

        $agreely->consentRequests()->create($this->buildInput($golden, $case));
        $this->assertCount(1, $http->calls);
        $call = $http->calls[0];
        $this->assertSame($case['expect']['method'], $call->method);
        $this->assertSame($case['expect']['path'], $call->path());
        // EXACT envelope: the body deep-equals the golden body — no items key,
        // no second document reference, nothing extra (TS<->PHP parity).
        $this->assertEquals($case['expect']['body'], $call->body);
        $this->assertNotNull($call->header('Idempotency-Key'));
    }
}
