<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Crypto\Canonicalizer;
use Agreely\Sdk\Types\Wire;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The offline receipt-verifier golden-vector parity gate. Loads the SHARED
 * vectors (../../vectors/vectors.json — the very file the TS suite asserts) and
 * checks that Agreely::verifyReceipt canonicalizes (JCS) BYTE-IDENTICALLY to the
 * expected ReceiptVerification. If TS and PHP crypto/verification ever drift,
 * this file fails.
 */
final class ReceiptVerificationTest extends TestCase
{
    /**
     * @return array{fixtures: array<string,mixed>, cases: list<array<string,mixed>>}
     */
    private static function rv(): array
    {
        /** @var array<string,mixed> $data */
        $data = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/vectors/vectors.json'), true);
        /** @var array{fixtures: array<string,mixed>, cases: list<array<string,mixed>>} $rv */
        $rv = $data['receiptVerification'];
        return $rv;
    }

    /**
     * @return array<string,array<string,mixed>>
     */
    private static function didDocuments(): array
    {
        /** @var array<string,array<string,mixed>> $docs */
        $docs = self::rv()['fixtures']['didDocuments'];
        return $docs;
    }

    /**
     * @return iterable<string,array{0:array<string,mixed>}>
     */
    public static function caseProvider(): iterable
    {
        foreach (self::rv()['cases'] as $case) {
            yield Wire::str($case['name']) => [$case];
        }
    }

    /**
     * @param array<string,mixed> $case
     */
    #[DataProvider('caseProvider')]
    public function testReceiptVerificationMatchesTheGoldenVectorByteForByte(array $case): void
    {
        $docs = self::didDocuments();
        $opts = [];
        if (($case['resolveDids'] ?? false) === 'none') {
            // Simulate an unresolvable DID (network/outage): the resolver always
            // returns null, so the decisive check is "unavailable", not "fail".
            $opts['resolver'] = static fn (string $did): ?array => null;
        } elseif (($case['resolveDids'] ?? false) === true) {
            $opts['resolver'] = static fn (string $did): ?array => $docs[$did] ?? null;
        }
        if (($case['ipfs'] ?? false) === true) {
            $body = (string) json_encode(self::rv()['fixtures']['ipfsBody']);
            $opts['ipfsGateway'] = static fn (string $cid): string => "https://ipfs.test/{$cid}";
            $opts['httpGet'] = static fn (string $url): string => $body;
        }

        $result = Agreely::verifyReceipt($case['receipt'], $opts);

        $canon = new Canonicalizer();
        $this->assertSame(
            $canon->encode($case['expect']),
            $canon->encode($result->toArray()),
            'ReceiptVerification drifted from the golden vector (TS<->PHP parity).',
        );
    }

    public function testCitizenAssertionFailsOnAChallengeMismatch(): void
    {
        $docs = self::didDocuments();
        $citizen = self::citizenReceipt();
        // Tamper the committed challenge on the WebAuthn proof.
        /** @var array<int,array<string,mixed>> $proof */
        $proof = $citizen['proof'];
        $proof[1]['challenge'] = '0x' . str_repeat('00', 32);
        $citizen['proof'] = $proof;

        $result = Agreely::verifyReceipt($citizen, [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
            // Stub the IPFS fetch so the offline test never touches the network.
            'httpGet' => static fn (string $url): ?string => null,
        ]);

        $this->assertSame('fail', $result->citizenAssertion);
        $this->assertSame('failed', $result->overall);
    }

    public function testCompanySignatureIsUnavailableWhenIssuerCannotBeResolved(): void
    {
        $manual = self::rv()['cases'][0]['receipt'];
        $result = Agreely::verifyReceipt($manual, ['resolver' => static fn (): ?array => null]);
        // A DID-resolution outage is INCONCLUSIVE, never byte-identical to a forgery.
        $this->assertSame('unavailable', $result->companySignature);
        $this->assertSame('unavailable', $result->overall);
    }

    public function testAThrowingResolverIsTreatedAsUnavailable(): void
    {
        $manual = self::rv()['cases'][0]['receipt'];
        $result = Agreely::verifyReceipt($manual, [
            'resolver' => static function (): ?array {
                throw new \RuntimeException('network down');
            },
        ]);
        $this->assertSame('unavailable', $result->companySignature);
        $this->assertSame('unavailable', $result->overall);
    }

    public function testDocumentAnchorPassesWithAnInjectedMatchingLog(): void
    {
        $docs = self::didDocuments();
        $body = (string) json_encode(self::rv()['fixtures']['ipfsBody']);

        $result = Agreely::verifyReceipt(self::citizenReceipt(), [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
            'ipfsGateway' => static fn (string $cid): string => "https://ipfs.test/{$cid}",
            'httpGet' => static fn (string $url): string => $body,
            'httpPost' => static fn (string $url, string $b): string => (string) json_encode(['result' => [['blockNumber' => '0x1']]]),
            'rpcUrl' => 'https://rpc.test',
        ]);

        $this->assertSame('pass', $result->documentAnchor);
    }

    /** @return array<string,mixed> */
    private static function citizenReceipt(): array
    {
        foreach (self::rv()['cases'] as $case) {
            if (($case['ipfs'] ?? false) === true) {
                /** @var array<string,mixed> $receipt */
                $receipt = $case['receipt'];
                return $receipt;
            }
        }
        self::fail('no citizen case in vectors');
    }
}
