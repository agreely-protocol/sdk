<?php

declare(strict_types=1);

namespace Agreely\Sdk\Crypto;

/**
 * Signature verification primitives for the offline receipt verifier, mirroring
 * the TS SDK's crypto/verify.ts:
 *
 *   - Ed25519 detached (the company eddsa-jcs-2022 proof) via libsodium.
 *   - WebAuthn assertion (the citizen proof): ES256 (ECDSA P-256, DER signature)
 *     via OpenSSL, or EdDSA (Ed25519) via libsodium, over
 *     authenticatorData || sha256(clientDataJSON).
 */
final class Signature
{
    /** Verify an Ed25519 detached signature over $message with a raw 32-byte key. */
    public static function verifyEd25519(string $publicKeyRaw, string $message, string $signature): bool
    {
        if (strlen($publicKeyRaw) !== 32 || strlen($signature) !== 64) {
            return false;
        }
        try {
            return sodium_crypto_sign_verify_detached($signature, $message, $publicKeyRaw);
        } catch (\SodiumException) {
            return false;
        }
    }

    /**
     * Verify a WebAuthn assertion signature over authenticatorData || sha256(clientDataJSON).
     *
     * @param array{alg:string, x:string, y:?string} $cose
     */
    public static function verifyWebAuthnAssertion(
        array $cose,
        string $authenticatorData,
        string $clientDataJSON,
        string $signature,
    ): bool {
        $message = $authenticatorData . hash('sha256', $clientDataJSON, true);

        if ($cose['alg'] === 'ES256' && $cose['y'] !== null) {
            $pem = self::p256Pem($cose['x'], $cose['y']);
            if ($pem === null) {
                return false;
            }
            return self::opensslVerifyQuietly($message, $signature, $pem);
        }
        if ($cose['alg'] === 'EdDSA') {
            return self::verifyEd25519($cose['x'], $message, $signature);
        }
        return false;
    }

    /**
     * openssl_verify over a caller-supplied (possibly attacker-controlled) P-256
     * key. A malformed key makes openssl_verify emit a noisy PHP Warning ("cannot
     * be coerced into a public key") while still correctly returning a non-1 result.
     * We swallow that warning so a bad key returns false CLEANLY (matching the TS
     * try/catch), instead of leaking a warning on every attacker-supplied bad key.
     */
    private static function opensslVerifyQuietly(string $message, string $signature, string $pem): bool
    {
        set_error_handler(static fn (): bool => true);
        try {
            $result = openssl_verify($message, $signature, $pem, OPENSSL_ALGO_SHA256);
        } finally {
            restore_error_handler();
        }
        return $result === 1;
    }

    /** Build a PEM SubjectPublicKeyInfo for a P-256 point from raw x,y (32 bytes each). */
    private static function p256Pem(string $x, string $y): ?string
    {
        if (strlen($x) !== 32 || strlen($y) !== 32) {
            return null;
        }
        // SPKI DER prefix for prime256v1, then the uncompressed point 0x04 || x || y.
        $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
        if ($prefix === false) {
            return null;
        }
        $der = $prefix . "\x04" . $x . $y;
        return "-----BEGIN PUBLIC KEY-----\n"
            . chunk_split(base64_encode($der), 64, "\n")
            . "-----END PUBLIC KEY-----\n";
    }
}
