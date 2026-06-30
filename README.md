# agreely-sdk

The official client SDKs for [Agreely](https://github.com/ophelios-studio/agreely), the Law 25 (Loi 25) data-consent accountability platform. A monorepo holding the TypeScript and PHP clients for the `/v1` consent API plus the single source of truth for their cross-language parity.

## Layout

- `ts/` — `@agreely/sdk`, the thin, typed TypeScript/Node client (fail-closed-by-default outage handling).
- `php/` — `agreely/sdk`, the platform-native PHP client (a near-mechanical port of the TS surface).
- `vectors/` — the **shared golden vectors** (`vectors/vectors.json`): the cross-SDK anti-drift gate. BOTH SDKs assert against this exact file, so a contract drift fails both languages on the same data.

## TypeScript (`ts/`)

```sh
cd ts
npm install
npm run build
npm run test:unit      # fast, offline unit suite
npm run test:contract  # live contract + golden-vector parity (needs the api; skips without a fixture)
```

## PHP (`php/`)

```sh
cd php
composer install
vendor/bin/phpunit --testsuite=unit       # fast, offline unit suite
vendor/bin/phpunit --testsuite=contract   # live contract + golden-vector parity (needs the api; skips without a fixture)
```

## Cross-language parity

Both contract suites load `vectors/vectors.json` (TS via `../../../vectors/vectors.json`, PHP via `dirname(__DIR__, 3) . '/vectors/vectors.json'`) and assert the same decision / status / consentRef-presence and the same typed errors against the live `/v1` API. Without a seeded fixture (the live stack) the suites skip cleanly. The fixture is seeded from the Agreely app's `scripts/sdk-contract-seed.php` against a running api.

Published later as `@agreely/sdk` (npm) and `agreely/sdk` (Packagist).
