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
npm run test:unit                     # fast, offline unit suite (default)
AGREELY_LIVE=1 npm run test:contract  # live contract + golden-vector parity (needs the api + fixture)
```

The live contract suites hit the stateful, rate-limited `/v1` API, so they are gated behind `AGREELY_LIVE=1` and OFF by default; the default `npm test` / `phpunit` runs the deterministic offline suite (including the OFFLINE golden-vector receipt parity).

## PHP (`php/`)

```sh
cd php
composer install
vendor/bin/phpunit --testsuite=unit                    # fast, offline unit suite (default)
AGREELY_LIVE=1 vendor/bin/phpunit --testsuite=contract # live contract + golden-vector parity (needs the api + fixture)
```

## Cross-language parity

Both contract suites load `vectors/vectors.json` (TS via `../../../vectors/vectors.json`, PHP via `dirname(__DIR__, 3) . '/vectors/vectors.json'`) and assert the same decision / status / consentRef-presence and the same typed errors against the live `/v1` API. Without a seeded fixture (the live stack) the suites skip cleanly. The fixture is seeded from the Agreely app's `scripts/sdk-contract-seed.php` against a running api.

## Verifying receipts (offline-first)

`Agreely.verifyReceipt` / `Agreely::verifyReceipt` verify a consent receipt and print an honest pass/trust matrix. "Offline-first", not fully offline: the signature/assertion checks need the signing key from the issuer/citizen DID document (one HTTPS resolution by default, or supply the DID document(s) via an injected `resolver` for a fully air-gapped verify). The IPFS disclosure copy and on-chain anchor are opt-in extra calls.

- **`unavailable` vs `fail`.** When a DID cannot be resolved (network outage, unreachable host, key not found) the affected check is reported `unavailable` and `overall: "unavailable"` — INCONCLUSIVE, never byte-identical to a tamper. A check only reads `fail` (and `overall: "failed"`) when the cryptography actively did not verify. A valid receipt during a resolver outage never looks like a forgery.
- **Untrusted receipts (SSRF).** The default `did:web` resolver fetches a host taken FROM THE RECEIPT (HTTPS-only; it can never yield a false `verified` because the key must still verify the signature). When verifying UNTRUSTED receipts, inject your own `resolver` (or supply DID documents locally) to control the request surface.

Published later as `@agreely/sdk` (npm) and `agreely/sdk` (Packagist).
