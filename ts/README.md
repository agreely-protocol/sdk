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
//   status: "active" | "none" | "revoked" | "expired" | "erased" | "relationship_ended",
//   consentRef?: "0x…",        // absent when status is "none"
//   checkedAt: "2026-…Z" }
```

`active` allows; every other status denies. `relationship_ended` is a
relationship-level stop (the company attested the purposes are accomplished,
art. 23) - the per-cell consent stays truthfully active, it was never withdrawn.

A consent **deny is a normal 200** - `checkDetailed` returns it, it does not
throw. Errors (auth, validation, rate-limit, outage) throw typed errors.

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
unique `Idempotency-Key` per call. Note: unlike `consentRequests.create`, the
server does **not** currently honor `Idempotency-Key` for manual consents, so a
retried `record` can create a **duplicate** attested consent. Guard against
duplicate submits yourself.

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

### List / get / catalog

```ts
const page = await agreely.consentRequests.list({ status: "pending", cursor });
// { items, nextCursor }  - nextCursor is null when exhausted; page size 50.

const one = await agreely.consentRequests.get("0x…");  // the protocol requestId, NOT a uuid
const catalog = await agreely.catalog.list();          // discovery for issuance
```

## Errors

Every failure is an `AgreelyError` subclass - a **deny is not an error**.

| Error                       | When                                  |
| --------------------------- | ------------------------------------- |
| `AgreelyAuthError`          | 401 unauthorized / 403 forbidden      |
| `AgreelyValidationError`    | 400 / 422 (`.field` names the input)  |
| `AgreelyNotFoundError`      | 404                                   |
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

## Timeouts & retries

Low default timeout (**800ms** total budget). Only idempotent reads and the
check are retried on a transient outage (network / 503): up to 2 attempts,
jittered, inside the budget. `consentRequests.create` is **never** retried.

```ts
new Agreely({ apiKey, timeout: 1200 }); // ms, including retries
```

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
- **Minimal deps, no install scripts.** Only an optional `undici` fallback.
- **Audit surface.** `src/transport.ts` and `src/verify/receipt.ts` are the only
  files that open a socket.

Agreely records and structures consent; it does not certify that your
organization is compliant.

## Links

- Product and API: https://agreely.ca
- Organization: https://github.com/agreely-protocol
