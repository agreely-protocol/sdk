# Changelog

All notable changes to `@agreely/sdk` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 0.2.0

### Added

- `consentRequests.list({ customerId?, status?, limit?, cursor? })` now accepts a
  `customerId` filter (the company's own subject reference) and a `limit` page
  size (server default 50, max 100), alongside the existing `status` and `cursor`.
  Returns the same `{ items, nextCursor }` page (metadata only, newest first,
  tenant-scoped by the API key).
- `consentRequests.hasPending(customerId, documentCode?)` — a dedup helper that
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
