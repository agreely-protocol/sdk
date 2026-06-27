<?php

declare(strict_types=1);

namespace Agreely\Sdk\Test\Contract;

/**
 * The live-fixture accessor for the contract suite. The fixture is produced by
 * `scripts/sdk-contract-seed.php` (run in the api container) and written to
 * test/Contract/fixture.json — the SAME seed + the SAME golden vectors the TS SDK
 * uses, which is what makes this the cross-SDK anti-drift gate.
 */
final class Fixture
{
    /** @param array<string,mixed> $data */
    private function __construct(private readonly array $data)
    {
    }

    public static function path(): string
    {
        return __DIR__ . '/fixture.json';
    }

    public static function exists(): bool
    {
        return is_file(self::path());
    }

    public static function load(): self
    {
        $raw = (string) file_get_contents(self::path());
        /** @var array<string,mixed> $data */
        $data = json_decode($raw, true);
        return new self($data);
    }

    private function s(string $key): string
    {
        $value = $this->data[$key] ?? '';
        return is_string($value) ? $value : '';
    }

    public function baseUrl(): string
    {
        return $this->s('baseUrl');
    }

    public function key(string $name): string
    {
        /** @var array<string,string> $keys */
        $keys = $this->data['keys'];
        return $keys[$name];
    }

    public function subject(): string
    {
        return $this->s('subject');
    }

    public function absent(): string
    {
        return $this->s('absent');
    }

    /** @return array{category:string,purpose:string,consentRef:string} */
    public function revocable(): array
    {
        /** @var array{category:string,purpose:string,consentRef:string} $r */
        $r = $this->data['revocable'];
        return $r;
    }

    /** @return array{catalogId:string,category:string,purpose:string,recipientEmail:string,validUntil:string} */
    public function issue(): array
    {
        /** @var array{catalogId:string,category:string,purpose:string,recipientEmail:string,validUntil:string} $i */
        $i = $this->data['issue'];
        return $i;
    }
}
