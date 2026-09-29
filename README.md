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
//   status: Status,            // the nine values below
//   consentRef?: "0x…",        // absent for "none" and for "necessity"
//   assurance?: "citizen_signed" | "company_attested" | "company_documented",
//   tier?: "full" | "manual" | "verbal",  // the same proof, present exactly when assurance is
//   basis?: Basis,             // ONLY on "necessity"
//   checkedAt: "2026-…Z" }
```

A consent **deny is a normal 200** - `checkDetailed` returns it, it does not
throw. Errors (auth, validation, rate-limit, outage) throw typed errors.

### The status vocabulary

Two statuses allow, seven deny:

| status | decision | what it means |
| --- | --- | --- |
| `active` | allow | a live consent record backs the cell |
| `necessity` | allow | **no consent record**; the catalog cell declares a non-consent ground the tenant's act carries. Carries `basis`, no `consentRef`, no `assurance`, no `tier`. Creates nothing. |
| `none` | deny | no record on a consent-basis cell. Also what an **erased** cell reads as. |
| `revoked` | deny | the consent was withdrawn (art. 14) |
| `expired` | deny | the consent lifespan elapsed (art. 14 al. 3) |
| `relationship_ended` | deny | the company attested the purposes are accomplished (art. 23). A relationship-level stop: the per-cell consent stays truthfully active, it was never withdrawn. |
| `requires_depersonalization` | deny | the cell declares a ground the act carries only for depersonalized information (A-2.1 art. 65.1 al. 2 (4°)), which cannot be met for a named customer. Not "no consent": do not answer it by collecting one. |
| `basis_not_in_regime` | deny | the cell declares a ground the tenant's act does not carry at all (usually left over from a sector change). The tenant re-declares the cell. |
| `erased` | deny | listed by `openapi.yaml`, **not currently emitted**. Erasure crypto-shreds the record, so an erased cell reads back as `none`. |

`sensitive_requires_consent` is **gone** (removed in 0.4.0; the API stopped
emitting it on 2026-09-28). A cell declared sensitive now answers by its basis like
any other: on `consent` it denies `none` (the consent must be express), on a
non-consent ground it allows `necessity` with its `basis`.

**A `necessity` allow is not a consent.** It rests on a basis the company
*declared* on its catalog, there is no signed proof behind it, and Agreely does not
certify its legal validity. The `basis` vocabulary is sector-keyed: a private
enterprise (P-39.1) gets `contract`, `necessary_for_service`, `security_fraud`,
`legal_obligation` or `professional_contact`; a public body (A-2.1) gets
`attributions`, `programme`, `entente_collecte`, `compatible_use`,
`manifest_benefit`, `law_application` or `public_character`. Read
`company.sector` from `identity()` before switching on it. Never present a
necessity allow to a person or an auditor as "consented":

```ts
if (d.status === "necessity") {
  // allowed, but on d.basis, NOT on consent
}
```

Treat any status you do not recognise as a **deny**: read `d.decision`, which is
only ever `allow` or `deny`.

### Proof tiers: `assurance` and `tier`

An allow on a consent tells you **how strong the proof is**, and your system
decides what each tier may unlock:

| `tier` | `assurance` | the consent |
| --- | --- | --- |
| `full` | `citizen_signed` | the person signed it with a passkey |
| `manual` | `company_attested` | the organisation recorded a hand-signed paper |
| `verbal` | `company_documented` | the person consented by telephone; the organisation documented it, with no document |

```ts
const d = await agreely.checkDetailed("cust_8812", "Email address", "Newsletter");
const acceptable = d.decision === "allow" && (d.tier === "full" || d.tier === "manual");
```

Treat an `assurance` or `tier` you do not recognise as **not acceptable**.

**Information lines are not consents.** A line the document gives *for
information* is recorded as the person's acknowledgement. `/v1/check` answers it
exactly like no record (`necessity` with its `basis`, or the usual refusal), with no
`consentRef` and no `assurance`/`tier`. Once withdrawn it answers deny `revoked`
**with** a `consentRef` but still no `assurance`/`tier`.

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

`validUntil` (here, on manual and on verbal consents) is either a plain date,
meaning **the end of that calendar day in the organisation's timezone**, or an RFC
3339 instant with an offset. Relative phrases (`"+1 year"`) are refused, and so is
an end more than **10 years** after the start (an Agreely product ceiling, not a
statutory one: the acts limit a consent to the time its purposes need).

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

`items` names the consent **asks ticked on the sheet**, and may be empty when
every ask was answered "no". The lines the document gives for information are
added by the server as acknowledgements (never consents) and come back in
`acknowledged`; one you send in `items` is ignored.

```ts
const recorded = await agreely.manualConsents.record({
  customerId: "cust_8812",
  documentVersionId: "<docVersionId>",
  effectiveDate: "2026-06-01",
  validUntil: "2031-01-01",
  items: ["<catalogEntryId>", { category: "Email address", purpose: "Newsletter" }],
  evidence: { pdfSha256: Agreely.hashPdf(bytes) }, // pdf?: "<base64>" to opt into uploading the bytes
});
// { consentId, merkleRoot, consentRefs: ["0x…"], assurance: "company_attested", anchored: false,
//   acknowledged: [{ category, purpose, consentRef }], asksDeclined: false }

// Hand the subject a link to self-claim the attestation:
const link = await agreely.manualConsents.createClaimLink({ customerId: "cust_8812" });
// { claimUrl, token, expiresAt }

const w = await agreely.manualConsents.revoke("0x…", { reason: "withdrawn" });
// { consentRef, revoked: true, alreadyRevoked, gate: "denied" | "superseded" | "unchanged" }
await agreely.manualConsents.erase("0x…");
```

What gets refused, and how:

- **422** (`AgreelyValidationError`): a document that asks no consent at all (a
  collection notice); an uploaded file that is empty or not a PDF; the SHA-256 of
  zero bytes; an upload that does not hash to `pdfSha256`; an end past the 10-year
  ceiling.
- **409** (`AgreelyConflictError`, `code: "conflict"`): a purpose already held by an
  active passkey consent, or a verbal consent for the same customer and document
  still awaiting its paper. Nothing is recorded.
- `createClaimLink`: **404** for a customer the company holds no record of
  (nothing written), **409** once the relationship has ended.

`revoke` returns `gate`, what `/v1/check` does now for that purpose: `denied`
(this consent backed it), `superseded` (a later consent had already taken over, and
the gate may still allow), or `unchanged` (an idempotent repeat). Read `gate`, not
`revoked`, before telling anyone the use stopped.

Like `consentRequests.create`, `record` is **never auto-retried**; it attaches a
unique `Idempotency-Key` per call, and a retry with the same key and the same body
replays the original 201 and records nothing new. On the manual and verbal
endpoints the server binds the key to the **endpoint and the request body**: the
same key with a different body is a new request, and a key spent elsewhere never
replays another endpoint's answer. An override must be 1 to 255 printable ASCII
characters; anything else is refused client-side.

### Record a verbal consent (by telephone)

A consent the person gave **by telephone**, documented by your organisation. It is
the weakest of the three tiers: there is no document, so the proof is your word.
Every result says `tier: "verbal"` and `assurance: "company_documented"`, and
`/v1/check` returns the same tier. Scope `attest_verbal`, a separate grant that is
never given by default.

```ts
const v = await agreely.verbalConsents.record({
  customerId: "cust_8812",
  documentVersionId: "<docVersionId>",
  // Every ask put on the call, answered explicitly. Never a line given for information.
  answers: [
    { category: "Email address", purpose: "Newsletter", answer: "yes" },
    { category: "Email address", purpose: "Surveys", answer: "no" },
  ],
  obtainedAt: new Date(),              // the call: RFC 3339 with an offset, at most 7 days old
  obtainedBy: "Julie, customer service",
  scriptVersion: "script-2026.09",
  respondent: { consentedBy: "self" }, // or a representative, see below
  validUntil: "2027-09-29",
  paperExpected: true,
});
// { consentId, merkleRoot, consentRefs, tier: "verbal", assurance: "company_documented",
//   anchored: false, paperExpected: true, acknowledged: [...], asksDeclined: false }

// The signed paper came back (scope `attest`): each "yes" moves into a NEW manual
// consent and the gate re-points at it; each "no" is a withdrawal dated at signedAt.
const p = await agreely.verbalConsents.confirmWithPaper(v.consentId, {
  signedAt: "2026-10-02T09:00:00-04:00",
  answers: [{ category: "Email address", purpose: "Newsletter", answer: "yes" }],
  evidence: { pdfSha256: Agreely.hashPdf(bytes) },
});
// { verbalConsentId, manualConsentId, merkleRoot, tier: "manual", confirmed: [...], withdrawn: [...] }

// What was said, what the paper said, what is in force (scope attest_verbal or attest):
const h = await agreely.verbalConsents.get(v.consentId);
// h.state: "awaiting_paper" | "verbal_only" | "paper_received"
// h.purposes[].answer: "yes" | "no" | "informed"
```

- **A minor under 14**: pass `isMinor: true` and a representative in the capacity
  `titulaire_autorite_parentale` or `tuteur_mineur`, named in `respondent.name`.
  The adult measures (`tutelle`, `curatelle`, `mandat_protection_homologue`,
  `representation_temporaire`, `other`, `undeclared`) are for adults only.
- **Sensitive purposes**: when a "yes" purpose is declared sensitive and rests on
  consent, pass `sensitiveExpressAttested: true`.
- **Refused**: 422 for a notice-only document or an answer on a line given for
  information; 409 (`code: "conflict"`) when a purpose is already covered or held
  by an active paper or passkey consent, when the relationship has ended, or for a
  second paper; 429 `AgreelyVerbalDailyCapError` at your organisation's daily limit
  (never auto-retried).
- **Withdraw** with `manualConsents.revoke` (a key holding only `attest_verbal`
  reaches verbal refs only). Once the paper came back, withdraw the confirming
  manual `consentRef` instead (see `verbalConsents.get`). **Erase** needs `attest`.
- `record` and `confirmWithPaper` are never auto-retried and carry an
  `Idempotency-Key` like `manualConsents.record`.

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
  status: "pending",         // pending | approved | asks_declined | refused | expired | revoked_before_action (optional)
  limit: 50,                 // page size, default 50, max 100 (optional)
  cursor,                    // a prior nextCursor (optional)
});
// { items, nextCursor }  - metadata only, newest first; nextCursor is null when exhausted.
// "approved" means the person accepted AT LEAST ONE consent ask. A request whose every
// ask was declined reads "asks_declined" (no consent obtained) and is never listed
// under "approved". waitForSettlement treats both as settled.

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

### Host retention: read the rules, declare the purges (scope `retention`)

Agreely **decides** the retention rules and **records** what your systems declare.
Your system reads the rules, runs its own purges, and declares them. Agreely
observes nothing in your systems and verifies none of it: every write answers
`status: "declared"`, never "verified".

```ts
// A nightly purge job.
const run = await agreely.retention.rulesForPurge({ snapshot: await loadSnapshot() });
if (run.source === "abstain") return; // Agreely unreachable: do NOT purge this run
await saveSnapshot(run.snapshot);

for (const rule of run.rules) {
  const purged = await purgeExpired(rule);           // your code
  const idempotencyKey = `${jobRunId}:${rule.key}`;  // durable, never random per attempt
  if (purged.count > 0) {
    await agreely.retention.declarePurge(rule.key, {
      ranAt: new Date(),
      recordsAffected: purged.count,                 // at least 1
      method: "destroyed",                           // or "anonymized" + anonymizationProcessKey
      coveredFrom: "2025-01-01",
      coveredUntil: "2025-01-31",
      hostSystem: "billing",                         // a STABLE name, never a pod name
      hostCategory: "invoices",
    }, { idempotencyKey });
  } else {
    await agreely.retention.declareSweep(rule.key, { sweptAt: new Date(), hostSystem: "billing" }, { idempotencyKey });
  }
}

const { cells } = await agreely.catalog.listCells(); // each cell with its retentionRuleKey
```

What the SDK makes impossible rather than merely documents:

- **The `Idempotency-Key` is a header.** It is the required third argument of
  `declarePurge` / `declareSweep`; leaving it out, or putting `idempotencyKey` in
  the body, does not compile, and the body is built from the named fields only.
- **`method` is `"destroyed"` or `"anonymized"`.** There is no third disposition
  (aggregation is a technique), and a third value, or the rule's own `"destroy"`,
  does not compile. `"anonymized"` without `anonymizationProcessKey` does not
  compile either.
- **`recordsAffected` is at least 1.** A pass that found nothing is a
  `declareSweep`, refused client-side as a purge of zero.
- **The sweep floor** (one per rule and `hostSystem` every 15 minutes) throws
  `AgreelySweepTooFrequentError`, a typed subclass of `AgreelyRateLimitError`
  carrying `retryAfterSeconds`, and is **never** auto-retried. Do not loop on it.
  A `sweptAt` older than 24 hours is refused before the wire call.
- **A 409** is `AgreelyConflictError`: retry with the same idempotency key.

What it can only tell you:

- **The replay is bound to the API key.** After a key rotation, retrying a
  declaration whose response was lost, with the NEW key, records a **second**
  declaration. Settle pending declarations before you revoke the old key.
- **Host-system names are rationed**: 10 per organisation (and 20 host categories
  per rule) over a rolling 30 days. A pod name, a container id or a hostname as
  `hostSystem` burns a slot per deploy. The SDK refuses the obvious shapes (a
  hexadecimal suffix, a run of five digits) but cannot catch `worker-3`.

#### When Agreely is unreachable: the purge job abstains

`rulesForPurge` fails the other way from `check`. For a consent check, failing
closed means denying. For a purge job it means **not purging**, because the two
ways stored rules can be wrong are not symmetrical:

- a rule was **shortened** and you missed it: you keep data somewhat too long. A
  minor lapse, corrected on the next run.
- a rule was **lengthened** (a legal hold, an investigation) and you missed it: you
  **destroy what you were required to keep**, and that does not repair.

So an outage returns `source: "abstain"` by default, and the abstain branch has no
`rules` to purge on (narrow on `source` or it does not compile). Purging on the
stored snapshot is the explicit exception, bounded and audited like fail-open:

```ts
const run = await agreely.retention.rulesForPurge({
  snapshot,
  onOutage: "use-snapshot",
  maxSnapshotAge: "26h",             // capped by the client's maxDegradeWindow (default 24h)
  onDegrade: (ctx) => audit.log(ctx) // mandatory
});
```

An auth, billing, validation or rate-limit failure is not an outage: it throws
rather than abstaining quietly.

### Host inventory (scope `inventory`)

```ts
await agreely.inventory.replaceCategories({
  hostSystem: "crm",
  categories: [{ key: "benevoles", label: "Bénévoles", fields: [{ key: "nom", label: "Nom" }] }],
});
const sets = await agreely.inventory.listCategories({ hostSystem: "crm" });
const statement = await agreely.inventory.getStatement(statementKey); // also readable with a 'check' key
```

`replaceCategories` sends the **complete** list for that system: every set it
declared before and that you omit is **withdrawn**. It is not an append. An empty
list is refused. Fields carry names, never values. A set whose
`decision.state` is not `"decided"` has no duration: abstain, never invent one.

## Errors

Every failure is an `AgreelyError` subclass - a **deny is not an error**.

| Error                       | When                                  |
| --------------------------- | ------------------------------------- |
| `AgreelyAuthError`          | 401 unauthorized / 403 forbidden      |
| `AgreelyValidationError`    | 400 / 422 (`.field` names the input)  |
| `AgreelyNotFoundError`      | 404                                   |
| `AgreelyBillingInactiveError` | 402 - the company's Agreely subscription lapsed |
| `AgreelyRateLimitError`     | 429 (`.retryAfter` seconds)           |
| `AgreelyVerbalDailyCapError` | 429 `verbal_daily_cap` (a rate-limit subclass; never auto-retried) |
| `AgreelyConflictError`      | 409: `code: "conflict"` (the record's state refuses it, do not retry as is) or `code: "retry"` (retry with the same Idempotency-Key) |
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
  endpoints; `attest` authorizes manual consents, the paper of a verbal consent,
  withdrawal and erasure; `attest_verbal` authorizes recording a verbal consent,
  reading its history and withdrawing verbal cells; `relationship` authorizes the
  relationship end/revert; `check` or `issue` reads the catalog.
- **Receipt verification.** `Agreely.verifyReceipt` recognises three receipt
  types: `company_attested` (paper; `overall: "verified"` when sound), `citizen`
  (at most `partial` offline) and `company_documented`, a verbal
  `VerbalConsentReceipt`: its company signature is verified, but `overall` is at
  most `partial`, because the organisation's word is all there is.

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
