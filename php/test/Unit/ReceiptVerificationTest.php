<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Crypto\Canonicalizer;
use Agreely\Sdk\Types\Wire;
use Agreely\Sdk\Verify\ReceiptVerifier;
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
            // Base Sepolia (84532) is no longer the default; passing it explicitly still
            // resolves the known testnet registry, so an integrator can test on Sepolia.
            'chainId' => 84532,
        ]);

        $this->assertSame('pass', $result->documentAnchor);
    }

    public function testDocumentAnchorResolvesDeployedMainnetRegistryByDefault(): void
    {
        $docs = self::didDocuments();
        $body = (string) json_encode(self::rv()['fixtures']['ipfsBody']);
        $anchorRequestBody = null;

        // No chainId passed -> default is Base mainnet (8453). The registry is now DEPLOYED
        // and VERIFIED, so the anchor check is no longer 'skipped': the verifier resolves the
        // live mainnet AgreelyRegistry and performs the on-chain documentAnchor lookup.
        $result = Agreely::verifyReceipt(self::citizenReceipt(), [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
            'ipfsGateway' => static fn (string $cid): string => "https://ipfs.test/{$cid}",
            'httpGet' => static fn (string $url): string => $body,
            'httpPost' => static function (string $url, string $b) use (&$anchorRequestBody): string {
                $anchorRequestBody = $b;

                return (string) json_encode(['result' => [['blockNumber' => '0x1']]]);
            },
            'rpcUrl' => 'https://rpc.test',
        ]);

        $this->assertSame('pass', $result->documentAnchor);
        // Prove the check targeted the real deployed Base mainnet registry address.
        $this->assertNotNull($anchorRequestBody);
        $this->assertStringContainsString('0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B', (string) $anchorRequestBody);
        $this->assertStringContainsString('eth_getLogs', (string) $anchorRequestBody);
    }

    public function testCorruptedCitizenKeyFailsCleanlyWithNoOpensslWarning(): void
    {
        // Corrupt the resolved passkey to an off-curve P-256 point (y = all zeros).
        // openssl_verify would otherwise emit a noisy PHP Warning on the malformed
        // key; the SDK swallows it so the check returns 'fail' CLEANLY. failOnWarning
        // is on in phpunit.xml, and this handler makes the intent explicit: any
        // leaked warning throws and fails the test.
        $docs = self::didDocuments();
        $citizenDid = 'did:agreely:citizen:BXZMTST2EGHYNQ62Q8AJWH8Q08';
        /** @var array<string,mixed> $doc */
        $doc = $docs[$citizenDid];
        /** @var array<int,array<string,mixed>> $vms */
        $vms = $doc['verificationMethod'];
        $cose = Wire::str($vms[0]['publicKeyCose']);
        $hex = str_starts_with($cose, '0x') ? substr($cose, 2) : $cose;
        // Replace the trailing y coordinate (32 bytes) with zeros -> not on the curve.
        $corruptHex = '0x' . substr($hex, 0, -64) . str_repeat('00', 32);
        $vms[0]['publicKeyCose'] = $corruptHex;
        $doc['verificationMethod'] = $vms;
        $docs[$citizenDid] = $doc;

        $body = (string) json_encode(self::rv()['fixtures']['ipfsBody']);

        set_error_handler(static function (int $severity, string $message): bool {
            throw new \RuntimeException("unexpected PHP warning/notice leaked: {$message}");
        });
        try {
            $result = Agreely::verifyReceipt(self::citizenReceipt(), [
                'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
                'ipfsGateway' => static fn (string $cid): string => "https://ipfs.test/{$cid}",
                'httpGet' => static fn (string $url): string => $body,
            ]);
        } finally {
            restore_error_handler();
        }

        $this->assertSame('fail', $result->citizenAssertion);
        $this->assertSame('failed', $result->overall);
    }

    /**
     * A company DID is did:web:agreely.ca:c:{slug}, served at the APEX host
     * https://agreely.ca/c/{slug}/did.json (never api.agreely.ca).
     */
    public function testResolveCompanyDidTargetsTheApexDidJsonUrl(): void
    {
        $expected = 'https://agreely.ca/c/acme/did.json';
        $requested = null;
        $verifier = new ReceiptVerifier([
            'httpGet' => static function (string $url) use (&$requested): ?string {
                $requested = $url;
                return json_encode(['id' => 'did:web:agreely.ca:c:acme']) ?: null;
            },
        ]);
        $verifier->resolveCompanyDid('acme');
        $this->assertSame($expected, $requested);
        $this->assertStringNotContainsString('api.agreely.ca', (string) $requested);
    }

    /**
     * Resolving the DID string did:web:agreely.ca:c:acme directly maps to the
     * same apex URL as the resolveCompanyDid('acme') slug input.
     */
    public function testDefaultResolverMapsCompanyDidStringToTheSameUrl(): void
    {
        $requested = null;
        $verifier = new ReceiptVerifier([
            'companyDidHost' => 'agreely.ca',
            'httpGet' => static function (string $url) use (&$requested): ?string {
                $requested = $url;
                return json_encode(['id' => 'did:web:agreely.ca:c:acme']) ?: null;
            },
        ]);
        $verifier->resolveCompanyDid('acme');
        $this->assertSame('https://agreely.ca/c/acme/did.json', $requested);
    }

    public function testGenuineCompanyReceiptReportsCellLabelBindingPass(): void
    {
        $docs = self::didDocuments();
        $result = Agreely::verifyReceipt(self::companyReceipt(), [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
        ]);
        $this->assertSame('pass', $result->cellLabelBinding);
        $this->assertSame('verified', $result->overall);
    }

    public function testMutatingItemCategoryBreaksTheCompanySignatureAndCellLabelBinding(): void
    {
        $docs = self::didDocuments();
        $receipt = self::companyReceipt();
        /** @var array<string,mixed> $subject */
        $subject = $receipt['credentialSubject'];
        /** @var array<string,mixed> $consent */
        $consent = $subject['consent'];
        /** @var array<int,array<string,mixed>> $items */
        $items = $consent['items'];
        $items[0]['category'] = 'HACKED';
        $consent['items'] = $items;
        $subject['consent'] = $consent;
        $receipt['credentialSubject'] = $subject;

        $result = Agreely::verifyReceipt($receipt, [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
        ]);
        $this->assertSame('fail', $result->companySignature);
        $this->assertSame('fail', $result->cellLabelBinding);
        $this->assertSame('failed', $result->overall);
    }

    public function testMutatingItemPurposeBreaksTheCompanySignatureAndCellLabelBinding(): void
    {
        $docs = self::didDocuments();
        $receipt = self::companyReceipt();
        /** @var array<string,mixed> $subject */
        $subject = $receipt['credentialSubject'];
        /** @var array<string,mixed> $consent */
        $consent = $subject['consent'];
        /** @var array<int,array<string,mixed>> $items */
        $items = $consent['items'];
        $items[0]['purpose'] = 'HACKED';
        $consent['items'] = $items;
        $subject['consent'] = $consent;
        $receipt['credentialSubject'] = $subject;

        $result = Agreely::verifyReceipt($receipt, [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
        ]);
        $this->assertSame('fail', $result->companySignature);
        $this->assertSame('fail', $result->cellLabelBinding);
        $this->assertSame('failed', $result->overall);
    }

    public function testCitizenReceiptNeverReportsCellLabelBindingPassEvenWhenLabelMutated(): void
    {
        $docs = self::didDocuments();
        $body = (string) json_encode(self::rv()['fixtures']['ipfsBody']);
        $genuine = Agreely::verifyReceipt(self::citizenReceipt(), [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
            'ipfsGateway' => static fn (string $cid): string => "https://ipfs.test/{$cid}",
            'httpGet' => static fn (string $url): string => $body,
        ]);
        $this->assertSame('unsupported', $genuine->cellLabelBinding);

        $receipt = self::citizenReceipt();
        /** @var array<string,mixed> $subject */
        $subject = $receipt['credentialSubject'];
        /** @var array<string,mixed> $consent */
        $consent = $subject['consent'];
        /** @var array<int,array<string,mixed>> $items */
        $items = $consent['items'];
        $items[0]['category'] = 'HACKED'; // offline: no salt/commitment/root to cross-check against
        $consent['items'] = $items;
        $subject['consent'] = $consent;
        $receipt['credentialSubject'] = $subject;

        $result = Agreely::verifyReceipt($receipt, [
            'resolver' => static fn (string $did): ?array => $docs[$did] ?? null,
            'verifyDisclosure' => false,
        ]);
        // Offline the citizen label cannot be cryptographically FAILED (by design), but it is
        // never 'pass', and the result is at most 'partial' — a relying party is not misled.
        $this->assertSame('unsupported', $result->cellLabelBinding);
        $this->assertNotSame('pass', $result->cellLabelBinding);
        $this->assertNotSame('verified', $result->overall);
        $matched = false;
        foreach ($result->notes as $note) {
            if (str_contains($note, 'Do NOT trust the displayed labels')) {
                $matched = true;
            }
        }
        $this->assertTrue($matched, 'expected the explicit do-not-trust-labels note on a citizen receipt');
    }

    /** @return array<string,mixed> */
    private static function companyReceipt(): array
    {
        /** @var array<string,mixed> $receipt */
        $receipt = self::rv()['cases'][0]['receipt'];
        return $receipt;
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
