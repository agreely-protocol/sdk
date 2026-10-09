# Changelog

All notable changes to `@agreely/sdk` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 0.5.0 - 2026-10-09

Covers the whole /v1 API in production since 2026-10-09. **0.4.0 below was
prepared but never published to npm**: 0.5.0 is the first npm release that
carries it, so anyone upgrading from 0.3.0 takes both entries, including the
breaking changes listed under 0.4.0. `^0.3.0` will not pick this up on its own.

### Breaking

- **A method that returns a promise now rejects, it never throws synchronously.**
  Invalid input (`AgreelyConfigError`) used to be thrown from the call itself on
  most methods; it now rejects the returned promise, so a `.catch()` chain sees it.
  Code that awaits inside a `try` is unaffected.
- **The options of a write are closed.** `manualConsents.record`,
  `verbalConsents.record` and `confirmWithPaper`, and the new writes below refuse an
  option they do not know: a misspelt `idempotencykey` used to be ignored and
  replaced by a random key, which made a retry the caller believed safe record
  twice.
- **Only `rate_limited` is ever auto-retried.** A 429 with any other code used to be
  rewritten to `rate_limited` and, on a read with `maxRetries`, retried. A known
  daily-cap code, or a `daily_cap` reason, now raises `AgreelyDailyCapError`; any
  other code raises `AgreelyRateLimitError` keeping its code. Neither is retried.
- **`AgreelyErrorCode` is open-ended** like `AgreelyErrorReason`: an exhaustive
  `switch` on `code` needs a default branch.
- **`relationships.end` and `revert` validate the customerRef like every customer
  route**: trimmed exactly as the server trims it (ASCII whitespace only, never a
  Unicode space), at most 200 characters, and never `.` or `..`.

### Added

- **`catalog.forDocument(documentCode)`**: the active cells of one published
  document (GET /v1/catalog?documentCode=), with the tenant's regime and the
  `documentVersionId` published today, for an intake screen built from the document
  the person signs. Type `DocumentCatalog`.
- **`agreely.consentDocuments`**: `list()`, `get(code)` (the published documents
  and their full disclosure, resolved by their stable code) and
  `getInformationPdf(documentVersionId, { locale })`, the information document of
  one version as PDF bytes to hand to the person. Types `ConsentDocumentSummary`,
  `ConsentDocumentDetail`, `ConsentDocumentItem`, `LocalizedText`,
  `InformationDocument`.
- **`manualConsents.createConsentSheet(customerRef, { documentVersionId, locale })`**
  (scope `attest`): the signature sheet of one version for one customer, minted with
  a new claim. The printed reference and the claim are returned once; a replayed key
  is a 409 `already_minted`. Never send the claim link in the same envelope as the
  sheet, and never send the blank sheet's hash as `evidence.pdfSha256`.
- **`agreely.withdrawals.record(customerRef, consentRef, { channel, operator,
  requestedAt?, reason? })`** (scope `withdraw`): the withdrawal a person asked for,
  recorded on her behalf, of any consent ask, a passkey-signed one included. Always
  `recordedOnBehalf: true` and `assurance: "company_attested"`, with `gate` and
  `alsoWithdrawn`. It works while the company's billing has lapsed.
- **`agreely.customers`** (scope `registry`): `get(customerRef)` (metadata only) and
  `upsert(customerRef, fields)`, a merge where an absent member is untouched and
  `null` clears it; `created` tells a 201 from a 200.
- **Per-customer retention on `agreely.retention`** (scope `registry`):
  `getCustomerRetention` (the derived clock with `held` per rule, the standing
  disposition, the holds), `declareDisposition` (with `agreelyIdentity` and the
  `hold_active` warning), `placeHold` and `releaseHold`.
- **The holds feed** (scope `holds`): `retention.listHolds` (one page),
  `retention.holdPages` (an async iterator) and `retention.syncHolds` (every page,
  with the cursor to persist; a snapshot without `changedSince`, a delta with it).
  Both throw rather than end on a partial feed, and a hold whose status is missing
  or unknown is read as active.
- **`validUntil` and `revokedAt`** on `CheckResult` and `BatchDecision`: the end of
  the consent behind a record-backed answer, and when a withdrawal took effect.
  Both are absent, never null, when there is no record.
- **`sensitiveExpressAttested` and `versionAttested`** on `manualConsents.record`,
  sent only when given and only as booleans.
- **`reason` on every `AgreelyError`**, the stable `error.reason` of a refusal, and
  `field` on every status (it was set on validation errors only). The known reasons
  are exported as `AgreelyErrorReason`, a string-literal union that stays
  open-ended, so a reason added later still compiles.
- **Daily caps have their own error class**, `AgreelyDailyCapError` (a subclass of
  `AgreelyRateLimitError`), for the 429 caps `withdrawal_daily_cap`,
  `hold_budget_exhausted` and `hold_release_cap_reached` and any 429 whose reason is
  `daily_cap`. `AgreelyVerbalDailyCapError` now extends it. None is ever
  auto-retried.
- **`IdempotencyOptions`**, the one options type of every write that takes an
  Idempotency-Key, closed to unknown members.
- `gate` on `ManualConsentErasure`. The `withdraw` and `holds` scopes on `Scope`.
  The error codes `withdrawal_daily_cap`, `already_minted`, `no_consent_ask`,
  `english_text_missing`, `identity_held`, `identity_erased`,
  `relationship_active`, `already_released`, `too_many_holds`,
  `hold_budget_exhausted`, `hold_release_cap_reached` and `new_set_limit` on
  `AgreelyErrorCode`.
- Constants `DOCUMENT_TIMEOUT_MS`, `RETENTION_TEXT_MAX`, `SCHEDULE_REF_MAX`,
  `WITHDRAWAL_CHANNELS`, `WITHDRAWAL_REASON_MAX`, `CUSTOMER_REF_MAX`.
- README: every new method, the two consent-sheet rules, and a section on liveness
  and caching (probe `identity()` about once a minute from one scheduler, purge any
  cache and fail closed on a 401 or a 402, never cache a check, never decide consent
  from a cached catalog).

### Changed

- **`INVENTORY_MAX_SETS` is 200**, the server's cap per declaration (it was 50).
  A declaration of 51 to 200 sets is no longer refused client-side.
- The two calls that render a PDF get a time budget of at least 15 s
  (`DOCUMENT_TIMEOUT_MS`), overridable per call, instead of the client's 800 ms
  default, which would cut off a sheet whose reference the server returns once.
- The time budget now also covers reading the response body: a body that stalls is
  treated as an outage instead of hanging.

### Fixed

- The documented skew on `obtainedAt` and `signedAt`: an instant in the future is
  refused by any amount (`obtained_at_in_future`, `signed_at_in_future`), not
  within 5 minutes.

## 0.4.0 - 2026-09-29 (never published to npm)

Prepared in this repository but never published to npm: its changes first ship
in 0.5.0. **Breaking**: 0.x bumps the minor for a breaking change, and
`^0.3.0` will not pick this up on its own.

### Breaking

- **`sensitive_requires_consent` is removed from `Status`.** The API stopped
  emitting it on 2026-09-28: a cell declared sensitive now answers by its declared
  basis, so on a non-consent ground it allows `necessity` with its `basis`, and on
  `consent` it denies `none`. Code that switched on it no longer compiles, which is
  the point: that branch can never fire again.
- **`approved` changed meaning, and `asks_declined` is new** on
  `ConsentRequestStatus` (and as a `list({ status })` filter). `approved` now means
  the person accepted at least one consent ask; a request whose every ask was
  declined reads `asks_declined` (no consent was obtained) and is never returned
  under `approved`. `waitForSettlement` treats it as settled; on 0.3.0 it polled
  such a request until the timeout.
- **`ReceiptType` gains `company_documented`** (see Fixed). An exhaustive switch
  on it must handle the new value.
- **`Status` gains `requires_depersonalization` and `basis_not_in_regime`**, and
  **`Basis` gains the seven A-2.1 (public body) grounds** (`attributions`,
  `programme`, `entente_collecte`, `compatible_use`, `manifest_benefit`,
  `law_application`, `public_character`). Both were already on the wire.
- **An `idempotencyKey` override on `manualConsents.record` is validated**: 1 to
  255 printable ASCII characters, else `AgreelyConfigError` before any call (the
  server refuses anything else with a 422).
- **A 409 and a 413 no longer raise `AgreelyUnavailableError`.** In 0.3.0 both fell
  through to the outage error; a 409 now raises `AgreelyConflictError` and a 413
  `AgreelyValidationError`. A `catch` that treated them as an outage no longer sees
  them.

### Added

- **`agreely.verbalConsents`**, a consent given by telephone and
  documented by the organisation, the weakest of three tiers: `record` (scope
  `attest_verbal`), `confirmWithPaper` (the signed paper, scope `attest`) and
  `get` (the history, either scope). Types: `RecordVerbalConsentInput`,
  `VerbalAnswer`, `VerbalRespondent`, `RepresentativeCapacity` (with
  `titulaire_autorite_parentale` and `tuteur_mineur` for a minor under 14),
  `VerbalConsentResult`, `ConfirmVerbalPaperInput`, `VerbalPaperResult`,
  `VerbalConsentHistory` (`answer` may be `"informed"`), `VerbalConsentState`.
  Answers must be exactly `"yes"` or `"no"`, a consentId must be a uuid, and
  `obtainedAt` / `signedAt` must carry an offset: all refused client-side.
- **`tier`** (`full` | `manual` | `verbal`) on `CheckResult` and `BatchDecision`,
  and **`company_documented`** on `Assurance`, which was a closed union that missed
  it. A new `Tier` type. Treat an unknown assurance or tier as not acceptable.
- **`acknowledged[]` and `asksDeclined`** on `ManualConsentResult`, and an
  `AcknowledgedLine` type. `items` may now be empty (every ask answered "no"); the
  server adds the information lines and ignores one sent in `items`.
- **`gate`** (`denied` | `superseded` | `unchanged`) on `ManualConsentRevocation`,
  with a `RevocationGate` type. `superseded` means a later consent still backs the
  purpose.
- **`AgreelyVerbalDailyCapError`** (429 `verbal_daily_cap`, a subclass of
  `AgreelyRateLimitError`), never auto-retried. The `conflict` and
  `verbal_daily_cap` codes on `AgreelyErrorCode`.
- The `attest_verbal` scope on `Scope`.
- **The `retention`, `inventory` and `registry` scopes** on `Scope`. A customer
  writing TypeScript could not name a valid scope for any of them. (`registry` has
  no resource yet.)
- **`agreely.retention`**: `listRules`, `getRule`, `declarePurge`, `declareSweep`,
  and `rulesForPurge`, which merges an incremental read over a stored snapshot and
  decides the outage for a purge job (abstain by default, see the README).
- **`agreely.catalog.listCells()`** (scope `retention`): every cell with its
  `retentionRuleKey`.
- **`agreely.inventory`**: `replaceCategories` (a complete list, not an append),
  `listCategories`, `getStatement`.
- `AgreelySweepTooFrequentError` (the 15-minute sweep floor, a subclass of
  `AgreelyRateLimitError`) and `AgreelyConflictError` (a 409, see Breaking).
- `legalBasis` and `sensitive` on `CatalogEntry`, and `company` on `Identity`: both
  were already on the wire.

### Fixed

- **A verbal receipt was verified as a FAILED citizen receipt.** The verifier read
  anything without the `CompanyAttestedConsentReceipt` type as a citizen receipt,
  found no passkey proof on a `VerbalConsentReceipt` and reported `overall:
  "failed"`: a false accusation of tampering on a genuine receipt. It now reports
  `receiptType: "company_documented"`, verifies the company signature, and returns
  at most `overall: "partial"`, never `"verified"`: the organisation's word is all
  a verbal receipt carries.
- **Stale documentation corrected**: the Idempotency-Key on manual and verbal
  consents IS bound to the endpoint and the request body (0.3.0 said it was not);
  `validUntil` as a plain date means the end of that calendar day in the tenant's
  timezone, relative phrases are refused, and a 10-year ceiling applies; the
  refusals of `manualConsents.record` (notice-only document, empty or non-PDF
  upload, hash mismatch, a verbal consent awaiting its paper) and of
  `createClaimLink` (404 unknown customer, 409 ended relationship) are documented;
  the P-39.1 citations on `Basis` now match openapi.yaml.
- **409 is split by code** in the docs of `AgreelyConflictError`: `retry` (retry
  with the same key) versus `conflict` (the record's state refuses it; do not retry
  as is).

## 0.3.0 - 2026-08-22

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
