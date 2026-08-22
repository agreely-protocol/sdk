# Changelog

All notable changes to `@agreely/sdk` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## Unreleased (recommend 0.3.0)

### Fixed

- **The pinned Base mainnet registry address was DEAD.** `src/verify/receipt.ts`
  shipped `0x1E31...cF8B`, a superseded AgreelyRegistry. That contract is still
  deployed and still answers `eth_getLogs`, it simply holds no anchors, so
  `verifyReceipt` with an `rpcUrl` and no explicit `registryAddress` reported
  `documentAnchor: "fail"` on every mainnet receipt: a confident FALSE ACCUSATION
  OF TAMPERING on valid evidence. The constant is now the live registry,
  `0x23577fafFa306375028D33a559D0F95Ced9424DB` (deploy block 48889369, EIP-55
  checksummed). Two tests pin it, one of them reading the address back off the
  composed JSON-RPC payload rather than off a second copy of the constant. Anyone
  on 0.2.0 who verifies mainnet anchors should upgrade.
- **Both default DID resolution hosts pointed at tiers that do not serve the
  route.** `companyDidHost` defaulted to the apex `agreely.ca`, which is the
  marketing site and 404s on `/c/{slug}/did.json` (the comment claiming it was "the
  apex host that serves /c/{slug}/did.json" was simply false); that document is
  served by the Agreely WEB tier, so the default is now `app.agreely.ca`. Worse,
  `citizenResolverBaseUrl` defaulted to `api.agreely.ca`, which does not route
  `GET /did/{did}` at all (that route is MODE=CITIZEN), so **every citizen receipt
  verified with the default resolver reported `citizenAssertion: "unavailable"` and
  `overall: "unavailable"`**: never a false "verified", but never a real verification
  either. The default is now `https://my.agreely.ca`. Verified against production:
  `app.agreely.ca/c/ophelios/did.json` returns 200 while the apex returns 404, and
  `my.agreely.ca/did/{did}` routes while `api.agreely.ca` returns 404.

  Company DIDs minted before this change read `did:web:agreely.ca:c:*` and will
  NEVER resolve, including in receipts already issued. That is not a regression this
  release introduces: those DIDs never resolved against any spec-compliant resolver.
  No compatibility shim and no fallback host is provided deliberately: a verifier
  that silently retries a second host hides which identity actually signed.
- **Removed every reference to a `receipts/verify` endpoint, which does not
  exist.** Two of them were in the human-readable `reason` notes returned to the
  person verifying a receipt, telling them to go use a server path that has never
  been built. The LIMITATION they describe is real and unchanged: a citizen
  receipt's company half signed the OFFER, which the receipt omits for
  unlinkability, and the salted cell labels cannot be re-derived offline. The
  REMEDY was wrong. The notes now say so plainly and point at the thing that does
  exist (the self-contained verification bundle Agreely issues with the receipt).
  Verdict semantics are untouched: `unsupported` / `partial` / `unavailable` mean
  exactly what they did.
- **Removed a false idempotency caveat on `manualConsents.record`.** It warned that
  the server did "not currently honor" `Idempotency-Key` for manual consents and
  that a retry could create a "duplicate" attested consent. The server has honoured
  it since 2026-07-01. The real behaviour is documented instead, including the one
  genuine caveat: the replay is keyed on (company, key) alone, not on the request
  body and not on the endpoint.

### Added

- `basis` on `CheckResult` and `BatchDecision`, and the `Basis` type. `openapi.yaml`
  documents it and the API returns it, so it was already arriving at runtime, but it
  was invisible to the type system: reading `result.basis` did not compile. Without
  it a `necessity` allow (no `consentRef`, no `assurance`) is indistinguishable from
  a consented one.
- `BATCH_CAP` (500) and `RATE_LIMIT_PER_MINUTE` (120, per COMPANY, not per key) are
  now exported. Neither limit was documented anywhere in the SDK.

### Changed

- **`Status` now carries all eight values `openapi.yaml` declares.** It was missing
  `necessity` and `sensitive_requires_consent` (shipped 2026-07-28), both of which
  the API returns today. This is a type-level breaking change for a consumer doing
  an exhaustive `switch` with a `never` guard: such code will now fail to compile
  until the two cases are handled, which is the point. Note that `erased` is listed
  by `openapi.yaml` but is NOT currently emitted: erasure crypto-shreds the
  enforcement record, so an erased cell reads back as `deny` / `none`.
- `checkBatch` and `checkFields` now throw `AgreelyConfigError` for an over-cap
  request BEFORE the wire call, instead of spending a request on a 422 that decides
  nothing. This matters most for `checkFields`, which builds a `refs x fields`
  product: 100 rows x 6 fields is 600 cells, over the cap, on an ordinary listing
  page. The error names both multiplicands and the safe page size.
- Documented that the 800ms default `timeout` is sized for a SAME-REGION call. The
  SDK fails closed, so an under-set timeout does not produce a slow answer, it
  produces a spurious DENY. The default is unchanged; internet-facing callers should
  raise it (`{ timeout: 8000, maxRetries: 1 }` is a tested pairing).
- Documented that `relationships.end` rejects with `AgreelyNotFoundError` for a
  customer who has no consent history, which includes a customer served only on
  declared-necessity cells even though `check` allows for that same ref.

## 0.2.0

### Added

- `consentRequests.list({ customerId?, status?, limit?, cursor? })` now accepts a
  `customerId` filter (the company's own subject reference) and a `limit` page
  size (server default 50, max 100), alongside the existing `status` and `cursor`.
  Returns the same `{ items, nextCursor }` page (metadata only, newest first,
  tenant-scoped by the API key).
- `consentRequests.hasPending(customerId, documentCode?)`: a dedup helper that
  reports whether an OPEN (still-pending) consent request already exists for a
  customer, optionally narrowed to a `documentCode`. Use it before
  `consentRequests.create` to avoid re-issuing (and re-emailing). A blank
  `customerId` throws `AgreelyConfigError` before any wire call. This is a
  metadata convenience, not a compliance decision.
- `ConsentRequestRecord` now surfaces `customerId` and `documentCode`.
- `customerId` and `limit` also flow through the auto-paginating `listAll` /
  `collect`.

## 0.1.1

- Surface HTTP 402 as the typed `AgreelyBillingInactiveError`
  (code `billing_inactive`).
