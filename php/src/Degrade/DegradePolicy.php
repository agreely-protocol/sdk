<?php

declare(strict_types=1);

namespace Agreely\Sdk\Degrade;

use Agreely\Sdk\Duration;
use Agreely\Sdk\Errors\AgreelyConfigError;

/**
 * The fail-closed default + the two-gate fail-open exception, ported from the TS
 * degrade.ts. (Gate 3, break-glass, is OMITTED in PHP v1 — see DegradeContext.)
 *
 * Default: on a 503 / timeout / network error, DENY. The exception is explicit,
 * scoped, and audited — never a silent global allow:
 *
 *   Gates 1+2 (config + per-call): a category fails open ONLY when it is in the
 *     config allow-list (gate 1) AND the call passes opts['onOutage'] === 'allow'
 *     (gate 2) — two independent gates — and the outage is still within
 *     maxOutageWindow.
 *
 * A 200 deny never reaches here (it is not an outage). Every degraded ALLOW emits
 * a DegradeContext via onDegrade; the fail-closed path emits nothing.
 *
 * Construction validates the config: mode must be "fail-open", onDegrade is
 * mandatory, and an over-cap maxOutageWindow throws (an unbounded fail-open window
 * is a compliance risk).
 */
final class DegradePolicy
{
    private readonly bool $enabled;
    /** @var callable(DegradeContext):void|null */
    private $onDegrade;
    /** @var array<string,true> */
    private array $allowList = [];
    private readonly ?int $maxOutageWindowMs;
    private ?float $outageStartedAt = null;
    /** One-time guard so an ineffective-opt-in warning doesn't spam the logs. */
    private bool $warnedIneffectiveOptIn = false;

    /**
     * @param array<string,mixed>|null $config the `degradeOnOutage` config (or null)
     */
    public function __construct(?array $config, int $maxWindowMs = Duration::DEFAULT_MAX_DEGRADE_WINDOW_MS)
    {
        if ($config === null) {
            $this->enabled = false;
            $this->onDegrade = null;
            $this->maxOutageWindowMs = null;
            return;
        }

        $mode = $config['mode'] ?? null;
        if ($mode !== 'fail-open') {
            throw new AgreelyConfigError(
                'degradeOnOutage.mode must be "fail-open"; got "' . var_export($mode, true) . '".',
            );
        }
        $onDegrade = $config['onDegrade'] ?? null;
        if (!is_callable($onDegrade)) {
            throw new AgreelyConfigError(
                'degradeOnOutage.onDegrade is mandatory when mode is "fail-open".',
            );
        }
        $window = $config['maxOutageWindow'] ?? null;
        if (!is_string($window) || $window === '') {
            throw new AgreelyConfigError(
                'degradeOnOutage.maxOutageWindow is mandatory when mode is "fail-open".',
            );
        }

        $this->enabled = true;
        $this->onDegrade = $onDegrade;
        $this->maxOutageWindowMs = Duration::parseCapped(
            $window,
            $maxWindowMs,
            'degradeOnOutage.maxOutageWindow',
        );
        /** @var list<string> $categories */
        $categories = is_array($config['categories'] ?? null) ? array_values($config['categories']) : [];
        foreach ($categories as $category) {
            $this->allowList[Duration::localPolicyKey((string) $category)] = true;
        }
    }

    /** A successful (200) check ends any tracked outage window. */
    public function markSuccess(): void
    {
        $this->outageStartedAt = null;
    }

    /**
     * Decide an outage. Returns the decision and, for an allow, emits the audit
     * record. Denies (fail-closed) are silent.
     *
     * @param array<string,mixed> $opts
     */
    public function evaluate(
        string $customerId,
        string $category,
        string $purpose,
        array $opts,
        \Throwable $error,
    ): DegradeDecision {
        $now = $this->nowMs();
        if ($this->outageStartedAt === null) {
            $this->outageStartedAt = $now;
        }

        // Gates 1 + 2: config allow-list AND per-call opt-in.
        $inAllowList = $this->enabled && isset($this->allowList[Duration::localPolicyKey($category)]);
        $optedIn = ($opts['onOutage'] ?? null) === 'allow';

        if ($inAllowList && $optedIn) {
            // maxOutageWindow: refuse to keep degrading past the window (fail closed).
            if (
                $this->maxOutageWindowMs !== null
                && $now - $this->outageStartedAt > $this->maxOutageWindowMs
            ) {
                return new DegradeDecision(false);
            }
            $this->emit($customerId, $category, $purpose, $error);
            return new DegradeDecision(true, 'fail-open');
        }

        // A per-call opt-in that reached here had NO effect (the category is not in
        // the config allow-list, or no degradeOnOutage config exists). It STILL
        // denies (safety unchanged), but the silent no-op is a footgun — warn once.
        if ($optedIn) {
            $this->warnIneffectiveOptIn($category);
        }

        // Default: fail closed.
        return new DegradeDecision(false);
    }

    /**
     * Fire-once warning that a per-call onOutage:"allow" was ignored and the check
     * was denied. Gated to one emission per policy instance and silenceable via the
     * AGREELY_SILENCE_WARNINGS env var. Never weakens safety.
     */
    private function warnIneffectiveOptIn(string $category): void
    {
        if ($this->warnedIneffectiveOptIn) {
            return;
        }
        if (getenv('AGREELY_SILENCE_WARNINGS') !== false) {
            return;
        }
        $this->warnedIneffectiveOptIn = true;
        error_log(
            "[agreely] onOutage:\"allow\" had no effect for category \"{$category}\" — the check was DENIED. "
            . 'A per-call fail-open is effective ONLY when the category is also listed in '
            . 'degradeOnOutage.categories (and degradeOnOutage is configured). Add the category to '
            . 'the allow-list. (Warns once per client; set AGREELY_SILENCE_WARNINGS to silence.)',
        );
    }

    private function emit(string $customerId, string $category, string $purpose, \Throwable $error): void
    {
        if (!$this->enabled || $this->onDegrade === null) {
            return;
        }
        ($this->onDegrade)(new DegradeContext(
            $customerId,
            $category,
            $purpose,
            'fail-open',
            false,
            $error,
            gmdate('Y-m-d\TH:i:s\Z'),
        ));
    }

    private function nowMs(): float
    {
        return microtime(true) * 1000;
    }
}
