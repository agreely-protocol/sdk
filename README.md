# @agreely/sdk

The thin, typed TypeScript/Node client for the Agreely **/v1 consent API**. One
call to gate data use on a live, authoritative consent check. No database, no ref
tables, no local mirror - every `check()` is a fresh, synchronous call to
Agreely (caching an allow while a revoke lands is a correctness failure).

- **One-call DX.** `if (await agreely.check(id, category, purpose)) { ... }`
- **Typed end to end.** Strict types, typed errors, ESM + CJS, full `.d.ts`.
- **Fail-closed by default.** On an outage `check()` denies - unless you opt in,
  explicitly and per-category, to a scoped, audited fail-open.
- **Node 18+** (global `fetch`), with a lazy `undici` fallback. Minimal deps.

## Install

```bash
npm install @agreely/sdk
```

## Quickstart

```ts
import { Agreely } from "@agreely/sdk";

const agreely = new Agreely({ apiKey: process.env.AGREELY_API_KEY! });

// Boolean gate - ALLOW is the only true. Send RAW human labels; Agreely
// normalizes server-side (never normalize them yourself).
if (await agreely.check("cust_8812", "Phone number", "Billing")) {
  // ...you may use the phone number for billing
}
```

### The reasoned form

```ts
const d = await agreely.checkDetailed("cust_8812", "Phone number", "Billing");
// { decision: "allow" | "deny",
//   status: Status,            // the eight values below
//   consentRef?: "0x…",        // absent for "none" and for "necessity"
//   assurance?: "citizen_signed" | "company_attested",  // absent for "none"/"necessity"
//   basis?: Basis,             // ONLY on "necessity"
//   checkedAt: "2026-…Z" }
```

A consent **deny is a normal 200** - `checkDetailed` returns it, it does not
throw. Errors (auth, validation, rate-limit, outage) throw typed errors.

### The status vocabulary

Two statuses allow, six deny:

| status | decision | what it means |
| --- | --- | --- |
| `active` | allow | a live consent record backs the cell |
| `necessity` | allow | **no consent record**; the catalog cell declares a non-consent lawful basis. Carries `basis`, no `consentRef`, no `assurance`. Creates nothing. |
| `none` | deny | no record on a consent-basis cell. Also what an **erased** cell reads as. |
| `revoked` | deny | the consent was withdrawn (art. 14) |
| `expired` | deny | the consent lifespan elapsed (art. 14 al. 3) |
| `relationship_ended` | deny | the company attested the purposes are accomplished (art. 23). A relationship-level stop: the per-cell consent stays truthfully active, it was never withdrawn. |
| `sensitive_requires_consent` | deny | no record, and the company declared the cell sensitive, so it fails closed to express consent (art. 12 al. 1 in fine / art. 13) |
| `erased` | deny | listed by `openapi.yaml`, **not currently emitted**. Erasure crypto-shreds the record, so an erased cell reads back as `none`. |

**A `necessity` allow is not a consent.** It rests on a basis the company
*declared* on its catalog (`contract`, `necessary_for_service`, `security_fraud`,
`legal_obligation`, `professional_contact`), there is no signed proof behind it,
and Agreely does not certify its legal validity. Never present it to a person or
an auditor as "consented":

```ts
if (d.status === "necessity") {
  // allowed, but on d.basis, NOT on consent
}
```

Treat any status you do not recognise as a **deny**: read `d.decision`, which is
only ever `allow` or `deny`.

### Issue a consent request (no UI)

```ts
const r = await agreely.consentRequests.create({
  customerId: "cust_8812",
  recipientEmail: "person@example.com",
  // REQUIRED: the published consent document (the Law 25 s. 8 disclosure) the
  // request is issued under. Pass its version id OR its code (one, not both);
  // the requested (category, purpose) items derive from the document.
  consentDocumentId: "<documentVersionId>", // or: documentCode: "conditions-marketing"
  validUntil: "2031-01-01",
});
// { requestId: "0x…64hex", status: "pending", deepLink, emailDelivered, items, document }
```

`create` is **never auto-retried** (it emails). The SDK attaches a unique
`Idempotency-Key` per call; pass your own to make a retry replay the original
instead of issuing twice:

```ts
await agreely.consentRequests.create(input, { idempotencyKey: "order-4471" });
```

### Record a manual / offline (company-attested) consent

When you gathered consent out of band (a signed paper or PDF), record it under
your company's attestation. The result carries `assurance: "company_attested"`
(the live citizen flow yields `"citizen_signed"`). Send only the PDF **hash** by
default; upload the bytes only if you opt in.

```ts
const recorded = await agreely.manualConsents.record({
  customerId: "cust_8812",
  documentVersionId: "<docVersionId>",
  effectiveDate: "2026-06-01",
  validUntil: "2031-01-01",
  items: ["<catalogEntryId>", { category: "Email address", purpose: "Newsletter" }],
  evidence: { pdfSha256: "0x…64hex" }, // pdf?: "<base64>" to opt into uploading the bytes
});
// { consentId, merkleRoot, consentRefs: ["0x…"], assurance: "company_attested", anchored: false }

// Hand the subject a link to self-claim the attestation:
const link = await agreely.manualConsents.createClaimLink({ customerId: "cust_8812" });
// { claimUrl, token, expiresAt }

await agreely.manualConsents.revoke("0x…", { reason: "withdrawn" });
await agreely.manualConsents.erase("0x…");
```

Like `consentRequests.create`, `record` is **never auto-retried**; it attaches a
unique `Idempotency-Key` per call.

The server honours that key on **both** endpoints: a retry with the same key
replays the original 201 byte-for-byte and records nothing new, so a dropped
connection can never double-issue or double-attest.

The key is the whole contract. The replay is keyed on **(company, key)** alone,
not on the request body and not on the endpoint. So:

- reusing a key with a **different payload** silently replays the *first* payload
  and writes nothing;
- a key already spent on `consentRequests.create` will replay **that** response
  from `manualConsents.record`.

Leave the key unset unless you have a durable, operation-unique id.

### End / revert a customer relationship (art. 23)

Attest that a customer relationship is over (Law 25 art. 23, "les fins sont
accomplies") from your own offboarding flow, and undo a mistaken end within the
correction window (art. 11 / art. 28). Both require a `reason` and fail closed
client-side on a blank one. Scope: `relationship`.

```ts
const ended = await agreely.relationships.end({
  customerRef: "cust_8812",           // your OWN ref (the check ref), never a DID
  reason: "account closed; purposes accomplished",
});
// { customerRef, status: "ended", endedAt, endedBy: "company" | "citizen_request" }

// Undo a premature/mistaken end (a correction, NOT a resurrection of dead consent):
const restored = await agreely.relationships.revert({
  customerRef: "cust_8812",
  reason: "offboarded the wrong account",
});
// { customerRef, status: "active", reverted: true }
```

Ending is a pure lifecycle overlay: it never revokes, erases, or hides any
per-cell consent. A non-undo-eligible revert (citizen-driven end, past the
window, or after any destruction) is a clean 404 with nothing written.

### List / lookup / get / catalog

```ts
const page = await agreely.consentRequests.list({
  customerId: "cust_8812",   // filter to one subject ref (optional)
  status: "pending",         // pending | approved | refused | expired | revoked_before_action (optional)
  limit: 50,                 // page size, default 50, max 100 (optional)
  cursor,                    // a prior nextCursor (optional)
});
// { items, nextCursor }  - metadata only, newest first; nextCursor is null when exhausted.

const one = await agreely.consentRequests.get("0x…");  // the protocol requestId, NOT a uuid
const catalog = await agreely.catalog.list();          // discovery for issuance
```

**Dedup before issuing.** `hasPending` answers "is a consent request already
outstanding for this customer?" so you do not re-issue (and re-email):

```ts
if (!(await agreely.consentRequests.hasPending("cust_8812", "conditions-marketing"))) {
  await agreely.consentRequests.create({
    customerId: "cust_8812",
    recipientEmail: "person@example.com",
    documentCode: "conditions-marketing",
    validUntil: "2031-01-01",
  });
}
```

The `documentCode` argument is optional; omit it to match any pending request for
the customer. This is a **metadata convenience** over the list endpoint, not a
compliance decision: it reports whether a pending request exists, it does not
assert consent was given. Each record now carries `customerId` and `documentCode`.

## Errors

Every failure is an `AgreelyError` subclass - a **deny is not an error**.

| Error                       | When                                  |
| --------------------------- | ------------------------------------- |
| `AgreelyAuthError`          | 401 unauthorized / 403 forbidden      |
| `AgreelyValidationError`    | 400 / 422 (`.field` names the input)  |
| `AgreelyNotFoundError`      | 404                                   |
| `AgreelyBillingInactiveError` | 402 - the company's Agreely subscription lapsed |
| `AgreelyRateLimitError`     | 429 (`.retryAfter` seconds)           |
| `AgreelyUnavailableError`   | 503 / network / timeout               |
| `AgreelyConfigError`        | bad client config (thrown at init)    |

```ts
import { AgreelyRateLimitError } from "@agreely/sdk";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await agreely.check(id, cat, pur);
} catch (e) {
  if (e instanceof AgreelyRateLimitError) await sleep((e.retryAfter ?? 1) * 1000);
  else throw e;
}
```

A `402` `AgreelyBillingInactiveError` means the **company's** Agreely subscription
lapsed (trial ended unpaid, `past_due`, or canceled) - not an outage. `check()`
**fail-closes** to `false` (a lapsed biller never gets an accidental allow), while
`checkDetailed()` **throws** it so you can surface it distinctly. It is actionable
(the company must pay to restore service), so treat it apart from "Agreely is down".

```ts
import { AgreelyBillingInactiveError } from "@agreely/sdk";

try {
  await agreely.checkDetailed(id, cat, pur);
} catch (e) {
  if (e instanceof AgreelyBillingInactiveError) {
    // Gate is closed AND the company must fix its billing. Surface, don't retry.
  } else throw e;
}
```

## Timeouts & retries

Low default timeout (**800ms** total budget). Only idempotent reads and the
check are retried on a transient outage (network / 503): up to 2 attempts,
jittered, inside the budget. `consentRequests.create` is **never** retried.

```ts
new Agreely({ apiKey, timeout: 1200 }); // ms, including retries
```

### Raise it if you are calling over the internet

800ms is sized for a call inside the **same datacentre or region** as the API. It
is not a safe budget over the open internet: a cold TLS handshake plus a
cross-region round trip can exceed it on a perfectly healthy server.

That matters because this SDK **fails closed**. A timeout is treated as an outage,
so `check()` returns `false` and `checkDetailed()` throws. An under-set timeout
does not give you a slow answer, it gives you a **spurious deny**, and the person
is shown less of their own data than they consented to.

```ts
// Internet-facing caller: give it room.
new Agreely({ apiKey, timeout: 8000, maxRetries: 1 });
```

The default is deliberately left low rather than raised for everyone: this is a
synchronous gate on a request path, and an unattended multi-second default would
turn an Agreely outage into a multi-second hang on every one of your pages.
Choose the budget your deployment can actually pay.

## Limits

| limit | value | what happens past it |
| --- | --- | --- |
| batch size | **500** cells per `checkBatch` / `checkFields` | the SDK throws `AgreelyConfigError` **before** the wire call (exported as `BATCH_CAP`). Server-side it is a 422 that decides nothing. |
| rate | **120 requests/minute per company** | 429 with `Retry-After`, surfaced as `AgreelyRateLimitError` (exported as `RATE_LIMIT_PER_MINUTE`) |

The rate limit is per **company**, not per api key, so every key you issue shares
one allowance. One `checkBatch` of 500 cells costs **one** request, which is the
whole point of batching.

`checkFields` builds a `refs x fields` product, so it hits the cap sooner than it
looks: 100 rows x 6 fields is 600 cells. It refuses client-side and tells you the
safe page size:

```
checkFields: 100 customerRefs x 6 fields = 600 cells, over the server cap of 500.
Page the customerRefs (at most 83 per call with 6 fields) or check fewer fields at a time.
```

The rate limit is a deployment default (`API_RATE_LIMIT_PER_MINUTE`); a
self-hosted or negotiated deployment may differ. Treat it as the number to design
against, not a contract.

## Outage behavior - fail-closed by default

When Agreely is unreachable (503 / timeout / network), `check()` **denies**
(returns `false`); `checkDetailed()` **throws** `AgreelyUnavailableError`. A
real `200` deny is never affected by any of this.

You can opt specific categories into **fail-open**, but only explicitly, scoped,
and audited - three independent gates:

```ts
const agreely = new Agreely({
  apiKey,
  degradeOnOutage: {
    mode: "fail-open",                 // the explicit word
    categories: ["Browsing/usage"],    // ONLY these may ever degrade  (gate 1)
    maxOutageWindow: "5m",             // refuse to degrade past this
    onDegrade: (ctx) => audit.log(ctx) // MANDATORY - absent, the constructor throws
  },
});

// gate 2: the call must ALSO opt in. Effective only because the category is
// allow-listed above. Without the config, a per-call opt-in still denies.
await agreely.check("cust_8812", "Browsing/usage", "Analytics", { onOutage: "allow" });
```

Every degraded **allow** emits an evidence record via `onDegrade`:
`{ customerId, category, purpose, mode, reason?, breakGlass, error, at }`.

### Break-glass (gate 3) - the operator lever for an active outage

```ts
agreely.breakGlass.engage({ reason: "incident-4471", ttl: "30m", scope: ["Browsing/usage"] });
// ...degraded checks in scope now allow, tagged breakGlass:true, until ttl expires
agreely.breakGlass.disengage();
```

Break-glass auto-expires, requires a `reason` (engaging without one throws), and
is independent of the config allow-list. Engage / disengage / expiry are audited
via the `onBreakGlass` callback.

Every **break-glass-authorized allow** also emits a per-decision `onBreakGlass`
event `{ action: "authorized", customerId, category, purpose, reason, error, at }`
- for *every* such allow, even with **no** `degradeOnOutage` config - so the
evidence trail shows every access permitted inside a break-glass window, not just
the engage/expire bookends.

### Bounding the window

Both a break-glass `ttl` and `degradeOnOutage.maxOutageWindow` are capped at
**24h** by default. A value over the cap (e.g. `ttl: "9999h"`) throws
`AgreelyConfigError` rather than opening an effectively-unbounded fail-open
window. Raise (or lower) the cap per client:

```ts
new Agreely({ apiKey, maxDegradeWindow: "12h" }); // default "24h"
```

> Heads-up: a per-call `{ onOutage: "allow" }` that is **not** backed by a
> matching `degradeOnOutage.categories` entry has no effect - the check still
> **denies**. The SDK logs a one-time dev warning when this happens; silence it
> with the `AGREELY_SILENCE_WARNINGS` env var.

## Notes

- **Never normalize** category/purpose before sending - the server does it.
- **Labels are bilingual and accent-tolerant.** The `category` and `purpose`
  passed to `check()` may be sent in French OR English, with or without accents,
  and are matched case- and whitespace-insensitively. English resolves only when
  the company actually disclosed an English label for that cell. If a label is
  ambiguous or undeclared the check fails closed (deny / `none`), so pass the
  label as declared in the catalog when you can.
- The public identifier everywhere is the **protocol `requestId`** (`0x` + 64
  hex), never an internal uuid.
- Scopes: `check` authorizes `check`; `issue` authorizes the consent-request
  endpoints; `attest` authorizes manual consents; `relationship` authorizes the
  relationship end/revert; any scope reads the catalog.

## Open and auditable

MIT-licensed and built to be provable, not just trusted:

- **No telemetry, no analytics, no phone-home.** No posthog/sentry/mixpanel/GA,
  no hidden fetch to an Agreely-controlled server, no data collection. Every
  network call is in the source.
- **Only the endpoints you configure.** The client contacts your configured
  Agreely API base URL (default `https://api.agreely.ca`). The opt-in receipt
  verifier additionally contacts a chain RPC you pass in (on-chain anchor) and an
  IPFS gateway (default `gateway.lighthouse.storage`, overridable) for the opt-in
  disclosure-copy check; its `did:web` resolver fetches the issuer host named in
  the receipt over HTTPS (inject your own `resolver` for untrusted receipts).
  Resolving a citizen DID calls the Agreely CITIZEN tier (default
  `https://my.agreely.ca/did/{did}`), and `resolveCompanyDid` calls the Agreely WEB
  tier (default `https://app.agreely.ca/c/{slug}/did.json`); both are overridable,
  and injecting your own `resolver` removes them entirely.
- **Minimal deps, no install scripts.** Only an optional `undici` fallback.
- **Audit surface.** `src/transport.ts` and `src/verify/receipt.ts` are the only
  files that open a socket.

Agreely records and structures consent; it does not certify that your
organization is compliant.

## The PHP SDK

On PHP instead of Node? The same client, same contract, same golden vectors:

- `agreely/sdk` on Packagist: https://packagist.org/packages/agreely/sdk
- Source: https://github.com/agreely-protocol/sdk-php

Both SDKs assert the **same shared golden vectors** so neither drifts from the
`/v1` contract.

## Links

- Product and API: https://agreely.ca
- Organization: https://github.com/agreely-protocol
