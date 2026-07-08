# agreely-sdk

The official client SDKs for [Agreely](https://agreely.ca), a Loi 25 (Quebec Law 25) consent-accountability layer. Agreely gives an organization one authoritative place to record who consented to what, and one call to check that record before it uses personal data. This monorepo holds the TypeScript and PHP clients for the `/v1` consent API, plus the single source of truth for their cross-language parity.

Agreely records and structures consent; it does not, and this SDK does not, certify that your organization is compliant. It gives you an authoritative, checkable consent record and an honest receipt verifier - the compliance judgment stays yours.

## Layout

- `ts/` - `@agreely/sdk`, the thin, typed TypeScript/Node client (fail-closed-by-default outage handling).
- `php/` - `agreely/sdk`, the platform-native PHP client (a near-mechanical port of the TS surface).
- `vectors/` - the **shared golden vectors** (`vectors/vectors.json`): the cross-SDK anti-drift gate. BOTH SDKs assert against this exact file, so a contract drift fails both languages on the same data.

## Open and auditable

This SDK is MIT-licensed and built to be provable, not just trusted:

- **No telemetry, no analytics, no phone-home.** There is no posthog/sentry/mixpanel/GA, no hidden fetch to an Agreely-controlled server, no data collection of any kind. Every network call is in the source and traceable.
- **It talks only to endpoints you configure.** The client contacts (a) your configured Agreely API base URL (default `https://api.agreely.ca`), and, for the opt-in receipt verifier, (b) a chain RPC you pass in for the on-chain anchor check and (c) an IPFS gateway (default `gateway.lighthouse.storage`, overridable) for the opt-in disclosure-copy check. The `did:web` receipt resolver fetches the issuer host named IN the receipt over HTTPS - inject your own `resolver` for untrusted receipts (see below).
- **Minimal dependencies.** TS: an optional `undici` fallback only. PHP: `ext-curl` + `ext-json`. No install/post-install scripts.
- **Audit it yourself.** Read `ts/src/transport.ts`, `php/src/Http/CurlHttpClient.php`, and `*/src/verify/*` - those are the only files that open a socket.

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

Both contract suites load `vectors/vectors.json` and assert the same decision / status / consentRef-presence and the same typed errors against the live `/v1` API. Without a seeded fixture (the live stack) the suites skip cleanly.

## The check-decision status vocabulary

`checkDetailed()` returns a `status` that explains the boolean:

| status | decision | meaning |
| --- | --- | --- |
| `active` | allow | a live, unexpired consent record backs this cell |
| `none` | deny | no record (the `consentRef` is absent) |
| `revoked` | deny | the consent was withdrawn |
| `expired` | deny | the consent lapsed |
| `erased` | deny | the cell was erased |
| `relationship_ended` | deny | the company attested the relationship is over (art. 23), a prospective relationship-level stop; the per-cell consent stays truthfully active (it was never withdrawn) |

## Verifying receipts (offline-first)

`Agreely.verifyReceipt` / `Agreely::verifyReceipt` verify a consent receipt and return an honest pass/trust matrix. "Offline-first", not fully offline: the signature/assertion checks need the signing key from the issuer/citizen DID document (one HTTPS resolution by default, or supply the DID document(s) via an injected `resolver` for a fully air-gapped verify). The IPFS disclosure copy and on-chain anchor are opt-in extra calls.

- **`unavailable` vs `fail`.** When a DID cannot be resolved (network outage, unreachable host, key not found) the affected check is reported `unavailable` and `overall: "unavailable"` - INCONCLUSIVE, never byte-identical to a tamper. A check only reads `fail` (and `overall: "failed"`) when the cryptography actively did not verify. A valid receipt during a resolver outage never looks like a forgery.
- **Untrusted receipts (SSRF).** The default `did:web` resolver fetches a host taken FROM THE RECEIPT (HTTPS-only; it can never yield a false `verified` because the key must still verify the signature). When verifying UNTRUSTED receipts, inject your own `resolver` (or supply DID documents locally) to control the request surface.

## Links

- Product and API: https://agreely.ca
- Organization: https://github.com/agreely-protocol
- The CLI over this SDK: `@agreely/cli` (in the org)

## License

MIT (c) Ophelios Studio. See [`LICENSE`](./LICENSE).
