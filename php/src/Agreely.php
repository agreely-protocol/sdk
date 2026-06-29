<?php

declare(strict_types=1);

namespace Agreely\Sdk;

use Agreely\Sdk\Degrade\DegradePolicy;
use Agreely\Sdk\Errors\AgreelyConfigError;
use Agreely\Sdk\Errors\AgreelyUnavailableError;
use Agreely\Sdk\Http\CurlHttpClient;
use Agreely\Sdk\Http\HttpClient;
use Agreely\Sdk\Http\RequestSpec;
use Agreely\Sdk\Http\Transport;
use Agreely\Sdk\Resources\Catalog;
use Agreely\Sdk\Resources\ConsentRequests;
use Agreely\Sdk\Resources\ManualConsents;
use Agreely\Sdk\Types\CheckResult;

/**
 * The Agreely client: a thin, near-stateless gate over the /v1 API. It holds an
 * api key, a base URL, an HTTP client, a timeout, and the degrade policy — NO
 * database, NO ref tables, and NO allow-cache (caching an allow while a revoke
 * lands mid-window is a stale-allow correctness failure, spec §16). Every check()
 * is a fresh authoritative call.
 *
 * Ported 1:1 from the @agreely/sdk TypeScript reference. Break-glass (TS gate 3)
 * is intentionally omitted in PHP v1 — it needs a shared store in PHP's
 * request-scoped model (see README + DegradeContext).
 */
final class Agreely
{
    private const DEFAULT_BASE_URL = 'https://api.agreely.ca';
    private const DEFAULT_TIMEOUT_MS = 800;

    private readonly Transport $transport;
    private readonly DegradePolicy $degrade;
    private readonly ConsentRequests $consentRequests;
    private readonly ManualConsents $manualConsents;
    private readonly Catalog $catalog;

    /**
     * Recognised keys: apiKey (string, required), baseUrl (string),
     * timeout (int ms), degradeOnOutage (array — see DegradePolicy),
     * maxDegradeWindow (duration string, e.g. "12h"), httpClient (HttpClient).
     *
     * @param array<string,mixed> $options
     */
    public function __construct(array $options)
    {
        $apiKey = $options['apiKey'] ?? '';
        if (!is_string($apiKey) || trim($apiKey) === '') {
            throw new AgreelyConfigError('Agreely requires an apiKey.');
        }

        $httpClient = $options['httpClient'] ?? new CurlHttpClient();
        if (!$httpClient instanceof HttpClient) {
            throw new AgreelyConfigError('options[httpClient] must implement ' . HttpClient::class . '.');
        }

        $baseUrl = isset($options['baseUrl']) && is_string($options['baseUrl'])
            ? $options['baseUrl']
            : self::DEFAULT_BASE_URL;
        $timeout = isset($options['timeout']) && is_int($options['timeout'])
            ? $options['timeout']
            : self::DEFAULT_TIMEOUT_MS;

        $this->transport = new Transport($baseUrl, $apiKey, $timeout, $httpClient);

        // The shared upper bound for the maxOutageWindow.
        $maxDegradeWindowMs = isset($options['maxDegradeWindow']) && is_string($options['maxDegradeWindow'])
            ? Duration::parse($options['maxDegradeWindow'])
            : Duration::DEFAULT_MAX_DEGRADE_WINDOW_MS;

        // Construction validates the degrade config (fail-open without onDegrade
        // throws, an over-cap maxOutageWindow throws).
        $degradeConfig = $options['degradeOnOutage'] ?? null;
        /** @var array<string,mixed>|null $degradeConfig */
        $degradeConfig = is_array($degradeConfig) ? $degradeConfig : null;
        $this->degrade = new DegradePolicy($degradeConfig, $maxDegradeWindowMs);

        $this->consentRequests = new ConsentRequests($this->transport);
        $this->manualConsents = new ManualConsents($this->transport);
        $this->catalog = new Catalog($this->transport);
    }

    /** The consent-request resource (issuance, scope 'issue'). */
    public function consentRequests(): ConsentRequests
    {
        return $this->consentRequests;
    }

    /** The manual / offline (company-attested) consent resource (scope 'attest'). */
    public function manualConsents(): ManualConsents
    {
        return $this->manualConsents;
    }

    /** The catalog resource (discovery, scope 'check' OR 'issue'). */
    public function catalog(): Catalog
    {
        return $this->catalog;
    }

    /**
     * The boolean-ergonomic consent gate. ALLOW is the only true. A 200 deny ->
     * false. On an outage, the fail-closed default returns false; the explicit,
     * scoped, audited exception (config + per-call opt) may return true. NEVER
     * throws on an outage — it resolves to a boolean.
     *
     * Send RAW category/purpose — the server normalizes; the SDK never does.
     *
     * @param array{onOutage?:'allow'|'deny'} $opts
     */
    public function check(string $customerId, string $category, string $purpose, array $opts = []): bool
    {
        try {
            return $this->resolve($customerId, $category, $purpose, $opts)->isAllow();
        } catch (AgreelyUnavailableError) {
            return false; // fail-closed deny
        }
        // Auth / validation / rate-limit / not-found surface as thrown errors.
    }

    /**
     * The reasoned form: the full decision object. A 200 deny returns normally
     * (deny is not an error). On an outage it THROWS AgreelyUnavailableError when
     * the policy fails closed, or returns a degraded allow (degraded:true) when the
     * explicit exception applies.
     *
     * @param array{onOutage?:'allow'|'deny'} $opts
     */
    public function checkDetailed(string $customerId, string $category, string $purpose, array $opts = []): CheckResult
    {
        return $this->resolve($customerId, $category, $purpose, $opts);
    }

    /**
     * Shared resolution. Sends category/purpose RAW. On a 200, returns the server
     * decision and clears any outage window. On an outage, applies the degrade
     * policy: a degraded allow returns a synthesized allow result; a fail-closed
     * outcome rethrows the outage error.
     *
     * @param array{onOutage?:'allow'|'deny'} $opts
     */
    private function resolve(string $customerId, string $category, string $purpose, array $opts): CheckResult
    {
        try {
            $wire = $this->transport->request(new RequestSpec(
                method: 'POST',
                path: '/v1/check',
                body: [
                    'customerId' => $customerId,
                    'category' => $category,
                    'purpose' => $purpose,
                ],
                idempotentRetry: true, // the check is a pure read; safe to retry
            ));
            $this->degrade->markSuccess();
            return CheckResult::fromWire($wire);
        } catch (AgreelyUnavailableError $error) {
            // Per-call explicit fail-closed shortcut.
            if (($opts['onOutage'] ?? null) === 'deny') {
                throw $error;
            }

            $decision = $this->degrade->evaluate($customerId, $category, $purpose, $opts, $error);
            if (!$decision->allow) {
                throw $error; // fail closed -> surface the outage
            }

            return new CheckResult(
                decision: 'allow',
                status: 'active',
                consentRef: null,
                checkedAt: gmdate('Y-m-d\TH:i:s\Z'),
                degraded: true,
                mode: $decision->mode,
            );
        }
    }
}
