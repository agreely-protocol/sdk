<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Unit;

use Agreely\Sdk\Agreely;
use Agreely\Sdk\Crypto\Canonicalizer;
use Agreely\Sdk\Crypto\CanonicalizationException;
use Agreely\Sdk\Crypto\Keccak;
use Agreely\Sdk\Crypto\Multibase;
use PHPUnit\Framework\TestCase;

/** The shared crypto primitives — the same values the TS crypto suite asserts. */
final class CryptoTest extends TestCase
{
    public function testKeccakEmptyVector(): void
    {
        $this->assertSame(
            '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
            Keccak::hashHex(''),
        );
    }

    public function testKeccakAbcVector(): void
    {
        $this->assertSame(
            '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
            Keccak::hashHex('abc'),
        );
    }

    public function testHashPdfIsZeroXSha256(): void
    {
        $this->assertSame(
            '0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
            Agreely::hashPdf('hello world'),
        );
    }

    public function testCanonicalizerSortsKeysAndForbidsNumbers(): void
    {
        $c = new Canonicalizer();
        $this->assertSame('{"a":"1","b":"2"}', $c->encode(['b' => '2', 'a' => '1']));
        $this->expectException(CanonicalizationException::class);
        $c->encode(['n' => 1]);
    }

    public function testMultibaseDecodesAKnownEd25519Key(): void
    {
        $raw = Multibase::decodeEd25519PublicKey('z6MkuDgiyAErthaCSCNj71p31Bo5DC5Gw8RBMtEb9c8YA5Kd');
        $this->assertSame(32, strlen($raw));
    }
}
