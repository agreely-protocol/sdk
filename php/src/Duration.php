<?php

declare(strict_types=1);

namespace Agreely\Sdk;

use Agreely\Sdk\Errors\AgreelyConfigError;

/**
 * Duration parsing + the degrade-window helpers, ported from the TS SDK's util.ts.
 * Pure, side-effect-free static helpers.
 */
final class Duration
{
    /**
     * Default upper bound for an open degrade window (a `degradeOnOutage.maxOutageWindow`).
     * 24h. An accountability product must not let an operator open an effectively
     * unbounded fail-open window ("9999h"); the cap is overridable per-client via
     * the `maxDegradeWindow` option.
     */
    public const DEFAULT_MAX_DEGRADE_WINDOW_MS = 24 * 3_600_000;

    /**
     * Parse a short duration string ("30s", "5m", "1h", "500ms") to milliseconds.
     * Throws AgreelyConfigError on a malformed value so misconfig surfaces early,
     * not mid-outage.
     */
    public static function parse(string $input): int
    {
        if (preg_match('/^(\d+)\s*(ms|s|m|h)$/', trim($input), $m) !== 1) {
            throw new AgreelyConfigError(
                "Invalid duration \"{$input}\". Use forms like \"500ms\", \"30s\", \"5m\", \"1h\".",
            );
        }
        $value = (int) $m[1];
        $scale = match ($m[2]) {
            'ms' => 1,
            's' => 1000,
            'm' => 60_000,
            default => 3_600_000,
        };
        return $value * $scale;
    }

    /**
     * Parse a duration AND enforce an upper bound. Throws AgreelyConfigError when
     * the value exceeds $maxMs. An unbounded degrade window is itself a compliance
     * risk, so the SDK refuses it at construction time rather than mid-outage.
     */
    public static function parseCapped(string $input, int $maxMs, string $label): int
    {
        $ms = self::parse($input);
        if ($ms > $maxMs) {
            throw new AgreelyConfigError(
                "{$label} \"{$input}\" exceeds the maximum allowed window ("
                . self::format($maxMs)
                . '). Lower it, or raise the cap via the client `maxDegradeWindow` option.',
            );
        }
        return $ms;
    }

    /**
     * A LOCAL policy key for degrade allow-list matching ONLY.
     *
     * IMPORTANT: this is NOT the server's normalizeKey and is NEVER applied to the
     * category/purpose SENT to the server (those go raw — the hard rule). It only
     * decides whether a category the integrator pre-declared in config matches the
     * category at a call site, so "Browsing/usage" and " browsing/usage " gate the
     * same way. A purely local, transparent comparison.
     */
    public static function localPolicyKey(string $value): string
    {
        return strtolower((string) preg_replace('/\s+/', ' ', trim($value)));
    }

    /** Render a millisecond count back to a compact duration string for messages. */
    private static function format(int $ms): string
    {
        if ($ms % 3_600_000 === 0) {
            return ($ms / 3_600_000) . 'h';
        }
        if ($ms % 60_000 === 0) {
            return ($ms / 60_000) . 'm';
        }
        if ($ms % 1000 === 0) {
            return ($ms / 1000) . 's';
        }
        return $ms . 'ms';
    }
}
