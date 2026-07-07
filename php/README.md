# agreely/sdk (PHP)

The thin, typed PHP client for the Agreely **/v1 consent API** (Law 25 / Loi 25).
One call to gate data use on a live, authoritative consent check. No database, no
ref tables, no local mirror — every `check()` is a fresh call to Agreely (caching
an allow while a revoke lands is a correctness failure, spec §16).

This is the PHP port of [`@agreely/sdk`](../sdk) (the TypeScript reference). Both
SDKs assert the **same shared golden vectors** (`../vectors/vectors.json`)
against the live API, so neither drifts from the contract.

- **One-call DX.** `if ($agreely->check($id, $category, $purpose)) { ... }`
- **Typed end to end.** Typed result objects, typed errors, PSR-4 / PSR-12, phpstan max.
- **Fail-closed by default.** On an outage `check()` denies — unless you opt in,
  explicitly and per-category, to a scoped, audited fail-open.
- **PHP 8.2+**, `ext-curl` + `ext-json`. Bring your own HTTP client (PSR-18 adapter)
  or use the bundled minimal curl client.

## Install

```bash
composer require agreely/sdk
```

## Quickstart

```php
use Agreely\Sdk\Agreely;

$agreely = new Agreely(['apiKey' => getenv('AGREELY_API_KEY')]); // baseUrl optional

// Boolean gate — ALLOW is the only true. Send RAW human labels; Agreely
// normalizes server-side (never normalize them yourself).
if ($agreely->check('cust_8812', 'Phone number', 'Billing')) {
    // ...you may use the phone number for billing
}
```

### The reasoned form

```php
$d = $agreely->checkDetailed('cust_8812', 'Phone number', 'Billing');
// $d->decision   "allow" | "deny"   (ALLOW is the only true)
// $d->status     "active" | "none" | "revoked" | "expired" | "erased"
// $d->consentRef "0x…"  (null when status is "none")
// $d->checkedAt  "2026-…Z"
```

A consent **deny is a normal 200** — `checkDetailed` returns it, it does not
throw. Errors (auth, validation, rate-limit, outage) throw typed errors.

### Issue a consent request (no UI)

```php
$r = $agreely->consentRequests()->create([
    'customerId'     => 'cust_8812',
    'recipientEmail' => 'person@example.com',
    // catalog entry ids AND/OR raw {category, purpose} pairs:
    // REQUIRED: the published consent document (the Law 25 s. 8 disclosure) the
    // request is issued under; the requested items derive from it server-side.
    'consentDocumentId' => '<documentVersionId>', // or: 'documentCode' => 'conditions-marketing'
    'validUntil'     => '2031-01-01',
]);
// $r->requestId  "0x…64hex"  (the protocol handle — the public id, NOT a uuid)
// $r->status "pending"; $r->deepLink; $r->emailDelivered; $r->items
```

`create` is **never auto-retried** (it emails). The SDK attaches a unique
`Idempotency-Key` per call; pass your own to make a retry replay the original 201
instead of issuing twice:

```php
$agreely->consentRequests()->create($input, ['idempotencyKey' => 'order-4471']);
```

### List / get / catalog

```php
$page = $agreely->consentRequests()->list(['status' => 'pending', 'cursor' => $cursor]);
// $page->items (list<ConsentRequestRecord>); $page->nextCursor (null when exhausted)

$one     = $agreely->consentRequests()->get('0x…'); // the protocol requestId, NOT a uuid
$catalog = $agreely->catalog()->list();             // discovery for issuance
```

## Errors

Every failure is an `Agreely\Sdk\Errors\AgreelyError` subclass — a **deny is not
an error**.

| Error                       | When                                  |
| --------------------------- | ------------------------------------- |
| `AgreelyAuthError`          | 401 unauthorized / 403 forbidden      |
| `AgreelyValidationError`    | 400 / 422 (`->field` names the input) |
| `AgreelyNotFoundError`      | 404                                   |
| `AgreelyRateLimitError`     | 429 (`->retryAfter` seconds)          |
| `AgreelyUnavailableError`   | 503 / network / timeout               |
| `AgreelyConfigError`        | bad client config (thrown at init)    |

```php
use Agreely\Sdk\Errors\AgreelyRateLimitError;

try {
    $agreely->check($id, $cat, $pur);
} catch (AgreelyRateLimitError $e) {
    sleep($e->retryAfter ?? 1);
}
```

Each error exposes `->code` (the wire code string), `->status` (HTTP status), and
`->field` (validation only).

## Timeouts & retries

Low default timeout (**800ms** total budget). Only idempotent reads and the check
are retried on a transient outage (network / 503): up to 2 attempts, jittered,
inside the budget. `consentRequests()->create` is **never** retried.

```php
new Agreely(['apiKey' => $key, 'timeout' => 1200]); // ms, including retries
```

## Outage behavior — fail-closed by default

When Agreely is unreachable (503 / timeout / network), `check()` **denies**
(returns `false`); `checkDetailed()` **throws** `AgreelyUnavailableError`. A real
`200` deny is never affected by any of this.

You can opt specific categories into **fail-open**, but only explicitly, scoped,
and audited — two independent gates:

```php
$agreely = new Agreely([
    'apiKey' => $key,
    'degradeOnOutage' => [
        'mode'            => 'fail-open',                   // the explicit word
        'categories'     => ['Browsing/usage'],            // ONLY these may degrade  (gate 1)
        'maxOutageWindow' => '5m',                          // refuse to degrade past this
        'onDegrade'      => fn ($ctx) => $audit->log($ctx), // MANDATORY — absent, the constructor throws
    ],
]);

// gate 2: the call must ALSO opt in. Effective only because the category is
// allow-listed above. Without the config, a per-call opt-in still denies.
$agreely->check('cust_8812', 'Browsing/usage', 'Analytics', ['onOutage' => 'allow']);
```

Every degraded **allow** emits a `DegradeContext` via `onDegrade`
(`customerId`, `category`, `purpose`, `mode`, `breakGlass`, `error`, `at`).

### Bounding the window

`degradeOnOutage.maxOutageWindow` is capped at **24h** by default. A value over
the cap (e.g. `"9999h"`) throws `AgreelyConfigError` rather than opening an
effectively-unbounded fail-open window. Raise (or lower) the cap per client:

```php
new Agreely(['apiKey' => $key, 'maxDegradeWindow' => '12h']); // default "24h"
```

> Heads-up: a per-call `['onOutage' => 'allow']` that is **not** backed by a
> matching `degradeOnOutage.categories` entry has no effect — the check still
> **denies**. The SDK logs a one-time dev warning (via `error_log`) when this
> happens; silence it with the `AGREELY_SILENCE_WARNINGS` env var.

### Break-glass — omitted in PHP v1 (by design)

The TS SDK ships a third degrade gate: an operator **break-glass** lever — a
runtime, auto-expiring override engaged in-process during an active outage. PHP
requests are typically **request-scoped** with no long-lived in-process "engaged"
state, so a break-glass that lives in a single object would not survive across
requests and would give a false sense of a fleet-wide override.

PHP v1 therefore **omits** break-glass and ships the parts that port cleanly and
correctly to a request-scoped model: the fail-closed default, the two-gate
fail-open (config allow-list + per-call opt-in), the `maxOutageWindow` cap, and
the one-time ineffective-opt-in warning. A future version can add break-glass
backed by a shared store (PSR-16 cache or an injected callable) so the engaged
state is visible across every PHP worker. Everything else keeps parity with the
TS SDK exactly.

## Bring your own HTTP client

The SDK depends only on an `Agreely\Sdk\Http\HttpClient` (one method: `send`).
The default is a minimal curl client. Inject your own (e.g. a Guzzle/PSR-18
adapter, or a test double) via `httpClient`:

```php
new Agreely(['apiKey' => $key, 'httpClient' => $myClient]);
```

## Notes

- **Never normalize** category/purpose before sending — the server does it.
- **Labels are bilingual and accent-tolerant.** The `category` and `purpose`
  passed to `check()` may be sent in French OR English, with or without accents,
  and are matched case- and whitespace-insensitively. English resolves only when
  the company actually disclosed an English label for that cell. If a label is
  ambiguous or undeclared the check fails closed (deny / `none`), so pass the
  label as declared in the catalog when you can.
- The public identifier everywhere is the **protocol `requestId`** (`0x` + 64
  hex), never an internal uuid; `consentRef` is `0x`-hex and **absent** when
  status is `none`.
- Scopes: `check` authorizes `check`; `issue` authorizes the consent-request
  endpoints; either reads the catalog.

## Development

```bash
composer install
composer test          # fast offline unit suite (mock transport)
composer stan          # phpstan level max
vendor/bin/phpcs       # PSR-12

# Live contract + golden-vector parity (needs `docker compose up api` on :8081):
make php-sdk-contract  # from the repo root — seeds a fixture, runs the contract suite
```

The contract suite asserts the PHP SDK against the live API **and** the shared
golden vectors (`../vectors/vectors.json`) — the cross-SDK anti-drift gate
(PHP == TS == the contract).
