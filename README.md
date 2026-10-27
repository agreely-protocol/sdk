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
//   validUntil?: "2027-…Z",    // the end of the consent behind the answer
//   revokedAt?: "2026-…Z",     // ONLY on "revoked": when the withdrawal took effect
//   checkedAt: "2026-…Z" }
```

A consent **deny is a normal 200** - `checkDetailed` returns it, it does not
throw. Errors (auth, validation, rate-limit, outage) throw typed errors.

`validUntil` and `revokedAt` are **absent, not null**, when there is no record
behind the answer (`none`, `necessity`, the named refusals) and on an
acknowledged information line. `checkBatch` decisions carry them the same way. They
date the answer; they never replace the next check: do not cache an allow until
its `validUntil`, a withdrawal can land at any moment.

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

### Consent documents: resolve the version you record against

Manual and verbal consents and consent sheets take a `documentVersionId`. Pin the
document's stable **code** and resolve the version published today through it,
instead of copying a uuid out of a browser (scope `check` or `issue`):

```ts
const documents = await agreely.consentDocuments.list();
// [{ code, documentVersionId, version, name, nameEn, effectiveDate, publishedAt, items }]
const doc = await agreely.consentDocuments.get("conditions-marketing");
// ...plus disclosure { purpose, means, categories, retention, withdrawal, recipients,
//    crossBorder, rights } as { fr, en }, responsable, automatedDecision, profiling, integrity

// The INFORMATION DOCUMENT of one version, to print and hand to the person
// (scopes check, issue, attest or attest_verbal):
const info = await agreely.consentDocuments.getInformationPdf(doc.documentVersionId, { locale: "fr" });
await writeFile(info.filename ?? "information.pdf", info.pdf); // Uint8Array
```

The PDF is served by **version id**, never by code: the version a consent is
recorded against is the one whose text the person must be given, and a version
superseded since is still served (it says so). English is refused (422, code
`english_text_missing`) when a section has no English text, rather than printed
without it. The bytes are not frozen, so keep your own copy, keyed on
(`documentVersionId`, `locale`). Fetching it records nothing: it is not evidence
that anyone was informed. A render takes longer than a check, so these calls get
a time budget of at least 15 s (`DOCUMENT_TIMEOUT_MS`), overridable with
`{ timeout }`.

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
  sensitiveExpressAttested: true, // when a ticked purpose is sensitive and rests on consent
  versionAttested: true,          // when the paper was signed before this version's publication
});
// { consentId, merkleRoot, consentRefs: ["0x…"], assurance: "company_attested", anchored: false,
//   acknowledged: [{ category, purpose, consentRef }], asksDeclined: false }

// Hand the subject a link to self-claim the attestation:
const link = await agreely.manualConsents.createClaimLink({ customerId: "cust_8812" });
// { claimUrl, token, expiresAt }

const w = await agreely.manualConsents.revoke("0x…", { reason: "withdrawn" });
// { consentRef, revoked: true, alreadyRevoked, gate: "denied" | "superseded" | "unchanged" }
const e = await agreely.manualConsents.erase("0x…");
// { consentRef, erased: true, alreadyErased, gate }
// Keeping a consent the person signed online in force (see the refusal below):
const k = await agreely.manualConsents.revoke("0x…", { otherConsents: "keep" });
// { ..., gate: "superseded", stillInForce: true }
```

`sensitiveExpressAttested` and `versionAttested` are the organisation's own
attestations, sent only when you pass them and only as booleans (a string
`"true"` is refused, never read as a yes). Absent is false.

What gets refused, and how (compare `error.reason`, never the message):

- **422** (`AgreelyValidationError`): a document that asks no consent at all
  (`notice_only`); an uploaded file that is empty or not a PDF; an upload that does
  not hash to `pdfSha256` (`pdf_hash_mismatch`); an end past the 10-year ceiling
  (`valid_until_too_far`); an `effectiveDate` in the future by any amount
  (`effective_date_in_future`); a sensitive consent purpose without
  `sensitiveExpressAttested` (`sensitive_express_required`); a paper signed before
  the version's publication without `versionAttested`
  (`version_attestation_required`).
- **409** (`AgreelyConflictError`, `code: "conflict"`): a purpose already held by a
  stronger consent (`stronger_consent_active`), an ended relationship
  (`relationship_ended`), or a verbal consent for the same customer and document
  still awaiting its paper (`verbal_awaits_paper`). Nothing is recorded.
- `revoke` and `erase`: **409** `citizen_consent_at_gate` when a consent the person
  signed with her passkey holds the purpose. These routes never end one: record her
  withdrawal with `withdrawals.record` (below). `otherConsents: "keep"` ends this
  record and leaves that consent in force, answering `stillInForce: true`; absent
  (or `"withdraw"`, which this route treats the same) the 409 stands. **409**
  `superseded_by_paper` for a verbal ref whose paper came back. **404**
  `unknown_consent`.
- `createClaimLink`: **404** `unknown_customer` for a customer the company holds no
  record of (nothing written), **409** `relationship_ended` once the relationship
  has ended.

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

### Print a consent sheet (scope `attest`)

The **signature sheet** of one published version for one customer, printed by
your system, minted together with a NEW claim the person may redeem later. The
sheet carries a printed reference, the claim link's second factor:

```ts
const sheet = await agreely.manualConsents.createConsentSheet("cust_8812", {
  documentVersionId: doc.documentVersionId,
  locale: "fr",
});
const pdf = Buffer.from(sheet.signatureSheet.pdf, "base64"); // print this
// sheet.printedReference: "ABCD-EFGH" (on the sheet)
// sheet.claim: { claimUrl, token, expiresAt } (send it SEPARATELY, see below)
```

Two rules, and the SDK cannot enforce either for you:

1. **Never send the claim link in the same envelope as the sheet**, nor in the
   same email, text message or piece of paper. The printed reference protects a
   link that travels on its own; delivered together, it protects nothing.
2. **Never send the blank sheet's hash as `evidence.pdfSha256`.** The evidence of
   the consent is the **signed** paper: scan it when it comes back, and record it
   with `manualConsents.record` and `Agreely.hashPdf` of the signed scan.

The reference and the claim token are returned **once** and stored nowhere. A
retry with the same Idempotency-Key is a 409 `already_minted` that mints nothing;
a new sheet retires the claim of the previous one, so its printed reference stops
working. Refusals: 404 `unknown_customer`, 422 `invalid_document` (not one of your
published versions), 422 code `no_consent_ask` with reason `notice_only` (the
version asks nothing, so there is nothing to sign), 409 `relationship_ended`.

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
  obtainedAt: callEndedAt,             // the call: a Date or RFC 3339 with an offset, at most 7 days old
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
- **No instant in the future, by any amount.** `obtainedAt` and `signedAt` ahead
  of Agreely's clock are refused (`obtained_at_in_future`, `signed_at_in_future`),
  never clamped. Keep your clock synchronised, and send the instant the call
  ended rather than a timestamp taken ahead of the request.
- **Renewal by telephone.** A paper consent ending within 30 days can be renewed
  by a verbal one: `record` as usual, with a `validUntil` no earlier than the
  paper's, then `confirmWithPaper` when the new paper comes back. Outside the
  window the purpose is refused as `stronger_consent_active` or `all_covered`;
  a renewal ending earlier is `renewal_ends_before_current`; a call before the
  paper's signature is `renewal_predates_current`; before a withdrawal,
  `predates_withdrawal`. A withdrawal through any reference of the chain withdraws
  the running consent too.
- **Refused**: 422 for a notice-only document or an answer on a line given for
  information (`informed_line_answered`); 409 (`code: "conflict"`) when a purpose
  is already covered or held by a stronger consent, when the relationship has
  ended (`relationship_ended`), or for a second paper (`already_confirmed`); 429
  `AgreelyVerbalDailyCapError` at your organisation's daily limit (never
  auto-retried).
- **Withdraw** with `manualConsents.revoke` (a key holding only `attest_verbal`
  reaches verbal refs only). Once the paper came back, withdraw the confirming
  manual `consentRef` instead (see `verbalConsents.get`). **Erase** needs `attest`.
- `record` and `confirmWithPaper` are never auto-retried and carry an
  `Idempotency-Key` like `manualConsents.record`.

### Record a withdrawal on the person's behalf (scope `withdraw`)

When a person asks you, by any channel, to withdraw a consent, record it here.
It reaches **any** consent ask you hold for her, including one she signed online
with her passkey, and `/v1/check` denies at once:

```ts
const w = await agreely.withdrawals.record("cust_8812", "0x…consentRef", {
  channel: "phone",        // phone | email | mail | in_person | other
  operator: "agent-042",   // YOUR opaque staff id, never an email address
  requestedAt: "2026-10-08T14:05:00-04:00", // optional: when she asked
  reason: "Asked on the phone", // optional, at most 1000 characters
  otherConsents: "keep",   // see below: "withdraw" | "keep", or alsoWithdraw: ["0x…"]
});
// { consentRef, withdrawn: true, alreadyWithdrawn, recordedOnBehalf: true,
//   assurance: "company_documented", gate: "denied" | "superseded" | "unchanged",
//   alsoWithdrawn: ["0x…"], stillInForce: ["0x…"] }
```

- **Honest by construction.** Every answer says `recordedOnBehalf: true` and
  `assurance: "company_documented"`: Agreely records that your organisation says it
  received and actioned the request, never that she signed a revocation.
- **A withdrawal attaches to the purpose, but you decide the other consents.** When
  another consent of the same purpose is in force (a renewal and the paper it
  renewed, a verbal consent and its paper, or a second person's consent), the call
  must say what happens to it: `otherConsents: "withdraw"` withdraws all of them,
  `alsoWithdraw: ["0x…"]` names the ones it covers (at most 50; `[]` declares
  nothing), and `otherConsents: "keep"` withdraws this consent alone. Never two of
  them together. Without a declaration the answer is 422 `other_consents_running`,
  an `AgreelyOtherConsentsRunningError` whose `otherConsentRefs` lists those
  consents: ask her which, then retry. Those carried at the same instant come back in
  `alsoWithdrawn`; those still in force in `stillInForce`. Read `gate` before telling
  anyone the use stopped.
- **Its own scope**, never granted by default: a key holding it can switch off every
  consent of your company one call at a time. A **daily cap** applies (429
  `AgreelyDailyCapError`, code `withdrawal_daily_cap`, reason `daily_cap`, no
  `Retry-After`); your account owner is notified. Record further ones in Agreely.
- **It works while your billing has lapsed**: honouring a withdrawal is a legal
  duty, not a paid service. It is the only route that does.
- **Refused**: 404 `unknown_consent` (unknown, another tenant's, or another
  customer's reference: one answer), 409 `consent_lapsed` (it ended on its own
  date; another consent may be in force, check the purpose), 422 `not_revocable`
  (the cell was never a consent ask), `requested_at_in_future`,
  `requested_at_before_grant`, `not_running_for_purpose` (an `alsoWithdraw` entry that
  is not another consent in force for the purpose). Accepted after the relationship ended.
- Never auto-retried; an Idempotency-Key is attached per call, and a retry with the
  same key and body replays the first answer.

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

### The customer registry (scope `registry`)

The identity your own system holds for one of its customers, recorded where the
accountability record lives. One `customerRef` at a time: there is no list
endpoint, by construction.

```ts
const r = await agreely.customers.upsert("cust_8812", {
  displayName: "Marie Tremblay",
  email: null,               // null or "" CLEARS a value
  noticeLocale: "fr",
});                          // a member you leave out is left as it stands
// { customerRef, registered, source, hasDisplayName, hasEmail, noticeLocale,
//   createdAt, updatedAt, relationship, created }

const meta = await agreely.customers.get("cust_8812"); // metadata only
```

- **A merge, never a replace.** A full replace would let a sync that only knows
  addresses wipe a name curated in Agreely. `created` is true when the call created
  the record (HTTP 201), false when it merged (200).
- **The read is metadata.** `hasEmail: true`, never the address: Agreely is not a
  place to read your customers back from.
- **409** carries its stable string in `code` here: `identity_erased` (a standing
  destruction removed the identity; a value would undo that, a clear still works)
  or `identity_held` (a hold keeps it as is, a clear included).

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
const form = await agreely.catalog.forDocument("conditions-marketing");
// { regime, document: { code, documentVersionId }, catalog }: only the active cells that
// document groups, so an intake screen asks about nothing the document does not cover
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
// A nightly purge job. Its key carries 'retention' AND 'holds'.
const run = await agreely.retention.rulesForPurge({ snapshot: await loadSnapshot() });
if (run.source === "abstain") return; // Agreely unreachable: do NOT purge this run
await saveSnapshot(run.snapshot);

// The holds in place: every reference you must skip. Any error throws: do not purge.
const held = await agreely.retention.syncHolds();    // a snapshot of every active hold

for (const rule of run.rules) {
  const purged = await purgeExpired(rule, held.holds); // your code: skip what a hold covers
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

#### Retention holds: what must be kept whatever the rules say

A hold suspends the rules it covers for one customer: the information under it must
be kept until the hold is released. Holds come from the rights register in Agreely
(an access or rectification request), from people in Agreely, and from your own
systems.

**The feed (scope `holds`)** is the list a purge job reads before purging:
references plus scope, never the ground.

```ts
// First run: a SNAPSHOT of every active hold, which replaces your whole active set.
let sync = await agreely.retention.syncHolds();
await saveActiveHolds(sync.holds, sync.cursor);

// Later runs: the DELTA since the stored cursor (each hold with its status).
sync = await agreely.retention.syncHolds({ changedSince: await loadCursor() });
await upsertHoldsById(sync.holds);   // delivery is at least once: upsert by id
await saveCursor(sync.cursor);
```

`syncHolds` follows the pages (500 holds each) for you; `holdPages` iterates them
and `listHolds({ changedSince, pageToken })` reads one. Only the last page carries
`cursor`. Treat **any** error on the feed (401, 403, 402, a 5xx, a timeout) as
"do not purge": `syncHolds` and `holdPages` throw rather than end on a partial feed
(with `holdPages`, collect the pages and purge only once the loop completes). A hold
whose `status` is missing or is anything but `"released"` is read as `"active"`.

**One customer (scope `registry`)**:

```ts
const r = await agreely.retention.getCustomerRetention("cust_8812");
// { relationship, clock: { trigger, recipe, dueAt, reason, rules[{ ..., held }] },
//   disposition, holds, releasedTruncated }

const hold = await agreely.retention.placeHold("cust_8812", {
  ground: "other_law",                       // or "rights_request" (no provision)
  provision: "Tax Administration Act, s. 35", // required for other_law, recorded as written
  scope: "all",                              // or { rules: [ruleKey], cells: [cellId] }
  startedOn: "2026-10-08",                   // optional, defaults to today
  reviewOn: "2027-10-08",                    // optional reminder; nothing releases on it
}, { idempotencyKey: `hold:${caseId}` });

await agreely.retention.releaseHold("cust_8812", hold.id, { reason: "Recourse period over" });
// { ..., status: "released", agreelyIdentity: "erased" | "none_held" | "retained_hold" | null }

await agreely.retention.declareDisposition("cust_8812", { disposition: "destroyed" });
// legal_hold requires a reason naming the law, and only it takes retentionUntil
```

- `clock.dueAt` is the earliest horizon of a rule **no hold suspends**, or null with
  `clock.reason`: `no_declared_rule` (never a defaulted period),
  `relationship_active`, or `hold_active`. A rule with `held: true` keeps its
  arithmetic `dueAt`, which is not a date to act on.
- A disposition needs the relationship to have **ended** first (409
  `relationship_active`): it never implies an end. One declared while a hold covers
  the customer is recorded with a `hold_active` warning, never refused.
- `releaseHold` lifts **any** active hold, including one the organisation placed
  (`placedBy: "organization"`). Your account owner is notified, and the API
  releases a capped number of those a day (429 `AgreelyDailyCapError`,
  `hold_release_cap_reached`). Placing holds has its own daily budget
  (`hold_budget_exhausted`). When the release lifts the last hold on all the
  information and a destruction or anonymization stands, it removes the name,
  email, basis note and notice language from Agreely's record, irreversibly
  (`agreelyIdentity: "erased"`).
- On these routes the stable string is in `code` (`already_released`,
  `too_many_holds`, `relationship_active`, `unknown_field`), not in `reason`.

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

Up to 200 sets per declaration (`INVENTORY_MAX_SETS`) and 60 fields per set; a set
label takes 120 characters and a field label 200. Set keys are stable names: at
most 1,000 keys your company never declared before may appear in any 30 days (422
`new_set_limit`), so generating keys per call locks you out, while re-sending the
same list always passes.

## Errors

Every failure is an `AgreelyError` subclass - a **deny is not an error**. Every
method that returns a promise **rejects**, it never throws synchronously: invalid
input rejects with `AgreelyConfigError` before any request. The options object of a
write is closed: a misspelt `idempotencykey` is refused, never ignored in favour of a
random key.

| Error                       | When                                  |
| --------------------------- | ------------------------------------- |
| `AgreelyAuthError`          | 401 unauthorized / 403 forbidden      |
| `AgreelyValidationError`    | 400 / 422 (`.field` names the input)  |
| `AgreelyOtherConsentsRunningError` | 422 `other_consents_running` on a withdrawal (an `AgreelyValidationError`): `.otherConsentRefs` lists the consents in force for the purpose |
| `AgreelyNotFoundError`      | 404                                   |
| `AgreelyBillingInactiveError` | 402 - the company's Agreely subscription lapsed |
| `AgreelyRateLimitError`     | 429 (`.retryAfter` seconds). `code: "rate_limited"` is the per-minute window, the only 429 ever auto-retried; any other code keeps its own and is never retried |
| `AgreelyDailyCapError`      | 429 on a per-company daily cap: `withdrawal_daily_cap`, `hold_budget_exhausted`, `hold_release_cap_reached`, or any 429 whose reason is `daily_cap` (a rate-limit subclass; never auto-retried) |
| `AgreelyVerbalDailyCapError` | 429 `verbal_daily_cap` (a daily-cap subclass; never auto-retried) |
| `AgreelyConflictError`      | 409: `code: "conflict"` (the record's state refuses it, do not retry as is), `code: "retry"` (retry with the same Idempotency-Key), or a named state (`already_minted`, `identity_held`, `identity_erased`, `relationship_active`, `already_released`) |
| `AgreelyUnavailableError`   | 503 / network / timeout               |
| `AgreelyConfigError`        | bad client config (thrown at init)    |

### `reason`: branch on it, never on the message

Every refusal of the manual, verbal, claim-link, consent-sheet and withdrawal
routes carries a **stable** `error.reason`, exposed as `e.reason` (typed
`AgreelyErrorReason`), beside the HTTP-level `e.code` and the input `e.field`.
The English `message` may be reworded at any time:

```ts
try {
  await agreely.manualConsents.revoke(ref);
} catch (e) {
  if (e instanceof AgreelyConflictError && e.reason === "citizen_consent_at_gate") {
    await agreely.withdrawals.record(customerRef, ref, { channel: "email", operator: "agent-042" });
  } else throw e;
}
```

`AgreelyErrorReason` lists the reasons this version knows and stays open-ended, so
a reason added later still compiles: handle an unknown one by its HTTP status. The
customer registry, holds, dispositions, inventory and document routes carry their
stable string in `code` instead, and leave `reason` undefined.

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
jittered, inside the budget. With `maxRetries`, a read also retries a 429
`rate_limited` after its `Retry-After`, and no other 429. No write is ever
auto-retried (`consentRequests.create` emails; the others record). The two calls that render a PDF
(`consentDocuments.getInformationPdf`, `manualConsents.createConsentSheet`) get at
least 15 s, overridable per call with `{ timeout }`: a cut-off sheet would lose a
reference the server returns only once.

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
| withdrawals | **50 per company per 24 hours** through the API (a deployment default) | 429 `AgreelyDailyCapError` (`withdrawal_daily_cap`), no `Retry-After`; the owner is notified |
| holds | **1,000 placed**, and **20 released that the API did not place**, per company per 24 hours (deployment defaults) | 429 `AgreelyDailyCapError` (`hold_budget_exhausted`, `hold_release_cap_reached`) |
| inventory | **200 sets** per declaration, **1,000 new set keys** per 30 days | `AgreelyConfigError` before the call over 200; 422 `new_set_limit` |
| customerRef | **200 characters** (`CUSTOMER_REF_MAX`) | `AgreelyConfigError` before the call |

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

## Liveness, caching and failing closed

- **Probe with `identity()`, about once a minute, from ONE scheduler**, not on every
  request: every call counts against the company's 120 a minute.
- **On a 401 or a 402, purge whatever you cached from Agreely and fail closed.** A
  revoked key or a lapsed subscription means none of it may be relied on.
- **Never cache `/v1/check`.** Every gate decision is a fresh call: an allow cached
  while a withdrawal lands is a use the person refused. `validUntil` dates an answer,
  it is not a time to live.
- **Never decide consent from a cached catalog.** The catalog and the documents say
  what was declared and asked, never whether this person consented. Only a check does.

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
  endpoints; `check` or `issue` reads the catalog and the consent documents;
  `attest` authorizes manual consents, consent sheets, claim links, the paper of a
  verbal consent, revoke and erasure; `attest_verbal` authorizes recording a verbal
  consent, reading its history and revoking verbal cells; `relationship` authorizes
  the relationship end/revert; `registry` the customer registry, the per-customer
  retention clock, dispositions and holds; `retention` the rules, purges and passes;
  `inventory` the host inventory; `withdraw` withdrawals recorded on a person's
  behalf; `holds` the holds feed. `attest_verbal`, `withdraw` and `holds` are never
  granted by default.
- **Receipt verification.** `Agreely.verifyReceipt` takes the verification
  bundle a passkey consent issues (`version "1"`: the receipt, its `signedOffer`
  and its `merkleRoot`) or a receipt file. A passkey (`citizen`) consent is
  `verified` only from its bundle, once every one of these holds: the company
  signature over the offer; the receipt matched against that offer, with its
  acceptance date (`grantedAt`) inside the offer's window, from `createdAt` to
  `expiresAt`; the passkey assertion bound to its content; and the citizen's DID
  document confirming that key, listed under `authentication` with a validity
  window `[validFrom, validUntil)` that covers `grantedAt`. A document that does not
  confirm the key reads `failed`, and one that cannot be read as that identity's
  document reads `unavailable`. An acceptance date outside the offer's window
  fails the receipt's integrity and leaves the passkey assertion `unavailable`:
  the person's key is not evaluated at that date. With `rpcUrl`, the on-chain
  checks read the AgreelyRegistry by `eth_call`: the document anchor passes on a
  `rootOf` record in the consent-document lane, and the consent anchor passes once
  every cell's record was read under the bundle's Merkle root and is in force. A
  withdrawn cell reads `withdrawn`, with its `revokedAt`: the consent is authentic but
  no longer in force, so `overall` reads `withdrawn` (never a forgery). A cell not yet
  recorded reads `unavailable`. On a chain other than Base mainnet and Base Sepolia, pass
  `registryAddress`, or the anchor checks read `unavailable`. With `rpcUrl`, a bundle whose
  issuer key delegation names a registry or chain other than the one read is refused before
  any RPC call when an anchor check would read the chain: a receipt with a `document.ipfsCid`
  (the document anchor) or a bundle with a `consentRef` (the consent anchor). Those checks read
  `unavailable` with an `unknown registry` note, and `overall` reads `unavailable` (never
  `verified`) unless a check failed. A bundle with neither reads nothing on chain, so the refusal
  does not apply, and it can read `verified`. Programs should read the `consentAnchorCounts`
  and `registryRefused` fields, not the notes, which are for humans. A bare
  passkey receipt proves nothing on its own: its assertion reads `unbound`,
  `overall` reads `incomplete`, and the notes say to verify the bundle.
  A `company_attested` paper receipt is `verified` when sound, bare or wrapped. A
  `company_documented` verbal `VerbalConsentReceipt` has its company signature
  verified, but `overall` is at most `partial`, because the organisation's word is
  all there is. The disclosure-copy check is opt-in (`verifyDisclosure: true`).
  The citizen half is checked only for a `did:agreely:citizen:` subject, whatever
  the resolver. A file the verifier cannot read (another bundle version, a
  non-object receipt or offer, nesting past 64 levels) reads `malformed`, never a
  throw. The on-chain checks (`rpcUrl`) share one deadline, `rpcDeadlineMs`
  (default 30000), past which they read `unavailable`.

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
