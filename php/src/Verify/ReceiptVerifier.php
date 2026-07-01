<?php

declare(strict_types=1);

namespace Agreely\Sdk\Verify;

use Agreely\Sdk\Crypto\Canonicalizer;
use Agreely\Sdk\Crypto\Cose;
use Agreely\Sdk\Crypto\Keccak;
use Agreely\Sdk\Crypto\Multibase;
use Agreely\Sdk\Crypto\Signature;
use Throwable;

/**
 * The offline-first, honest consent-receipt verifier — a byte-for-byte behavioural
 * port of the TS SDK's ReceiptVerifier. Its ReceiptVerification result canonicalizes
 * (JCS) identically to the TS output, asserted by the shared golden vectors.
 *
 * "Offline-first", not "fully offline": the signature/assertion checks need the
 * signing key from the issuer/citizen DID document (by default one HTTPS resolution,
 * or supply the DID document(s) via an injected `resolver` for an air-gapped verify).
 * IPFS/anchor are the opt-in extra calls. When a DID cannot be resolved the affected
 * check is reported "unavailable" (inconclusive) — never "fail" (a real tamper).
 *
 * A company-attested receipt is fully offline-sound (Ed25519 over the JCS body). A
 * citizen receipt is HONESTLY PARTIAL offline (the company half signed the original
 * offer, omitted for unlinkability; use the server receipts/verify). The citizen
 * WebAuthn assertion IS checkable (passkey-possession over the committed challenge).
 *
 * SECURITY: the default did:web resolver fetches a host TAKEN FROM THE RECEIPT (it
 * can never yield a false "verified" — the key must still verify — but when
 * verifying UNTRUSTED receipts, inject your own `resolver` or supply DID documents
 * locally to control the request surface). HTTPS is enforced (no http/file).
 *
 * Options (all network seams injectable, so tests run with NO network):
 *   - resolver:            callable(string $did): ?array  — DID document or null
 *   - companyDidHost:      string (default agreely.ca, the apex host serving /c/{slug}/did.json) for resolveCompanyDid
 *   - citizenResolverBaseUrl: string (default https://api.agreely.ca)
 *   - ipfsGateway:         callable(string $cid): string  — CID -> URL
 *   - httpGet:             callable(string $url): ?string — fetch body (IPFS)
 *   - httpPost:            callable(string $url, string $body): ?string — JSON-RPC
 *   - rpcUrl, registryAddress, chainId — opt-in on-chain documentAnchor
 */
final class ReceiptVerifier
{
    private const DEFAULT_COMPANY_HOST = 'agreely.ca';
    private const DEFAULT_CITIZEN_BASE = 'https://api.agreely.ca';
    private const DEFAULT_IPFS_GATEWAY = 'https://gateway.lighthouse.storage/ipfs/';
    private const DEFAULT_CHAIN_ID = 84532;
    private const REGISTRY_BY_CHAIN = [
        84532 => '0x36eaA3F10744FA3ABF140c1eED68F9B03ED7b65E',
        8453 => null,
    ];

    private Canonicalizer $canonicalizer;

    /** @param array<string,mixed> $opts */
    public function __construct(private readonly array $opts = [])
    {
        $this->canonicalizer = new Canonicalizer();
    }

    /** @param mixed $receipt a parsed receipt VC (assoc array) */
    public function verify(mixed $receipt): ReceiptVerification
    {
        $r = self::asObject($receipt);
        $type = self::receiptType($r);
        $notes = [];

        if ($type === 'company_attested') {
            $companySignature = $this->verifyCompanySignature($r, $notes);
            $citizenAssertion = 'unsupported';
            $notes[] = 'A company-attested receipt carries no citizen passkey assertion, so citizenAssertion is not applicable.';
        } else {
            $companySignature = 'unsupported';
            $notes[] = 'Company signature is UNSUPPORTED offline on a citizen receipt: the company signed the original offer '
                . '(including the subject reference and full disclosure), which the receipt omits for unlinkability. '
                . 'Use the server receipts/verify endpoint for a sound company-signature check.';
            $citizenAssertion = $this->verifyCitizenAssertion($r, $notes);
        }

        $disclosureCopy = $this->verifyDisclosureCopy($r, $notes);
        $documentAnchor = $this->verifyDocumentAnchor($r, $notes);

        $overall = self::decideOverall($type, $companySignature, $citizenAssertion, $disclosureCopy, $documentAnchor);

        return new ReceiptVerification(
            $type,
            $companySignature,
            $citizenAssertion,
            $disclosureCopy,
            $documentAnchor,
            $overall,
            $notes,
        );
    }

    /**
     * @param array<array-key,mixed> $r
     * @param list<string> $notes
     */
    private function verifyCompanySignature(array $r, array &$notes): string
    {
        $issuer = self::asString($r['issuer'] ?? null);
        $proofs = self::asArray($r['proof'] ?? null);
        $proof = self::asObject($proofs[0] ?? null);
        $vm = self::asString($proof['verificationMethod'] ?? null);
        $proofValue = self::asString($proof['proofValue'] ?? null);

        if ($issuer === '' || $proofValue === '') {
            $notes[] = 'Company signature check FAILED: the receipt is missing its issuer or proofValue.';
            return 'fail';
        }

        $body = $r;
        unset($body['proof']);
        $canonical = $this->canonicalizer->encode($body);

        try {
            $signature = Multibase::decodeBytes($proofValue);
        } catch (Throwable) {
            $notes[] = 'Company signature check FAILED: the proofValue is not a valid multibase signature.';
            return 'fail';
        }

        $key = $this->resolveEd25519Key($issuer, $vm);
        if ($key === null) {
            $notes[] = "Company signature UNVERIFIABLE: could not resolve the issuer DID {$issuer} (key {$vm}) to an Ed25519 key "
                . '(network/resolution failure or key not found). This is INCONCLUSIVE, NOT a signature mismatch.';
            return 'unavailable';
        }

        if (Signature::verifyEd25519($key, $canonical, $signature)) {
            $pdfHash = self::asString(self::asObject($r['evidence'] ?? null)['pdfHash'] ?? null);
            $notes[] = "Company signature verified against issuer DID {$issuer} (key {$vm}).";
            $notes[] = "This proves the company ATTESTED to a hand-signed PDF (hash {$pdfHash}); it does NOT prove a human signed.";
            return 'pass';
        }

        $notes[] = "Company signature check FAILED against issuer DID {$issuer} (key {$vm}): the canonical receipt body does not "
            . 'match the signature. The receipt was altered after signing or the wrong key was resolved.';
        return 'fail';
    }

    /**
     * @param array<array-key,mixed> $r
     * @param list<string> $notes
     */
    private function verifyCitizenAssertion(array $r, array &$notes): string
    {
        $subject = self::asObject($r['credentialSubject'] ?? null);
        $citizenDid = self::asString($subject['id'] ?? null);
        $proof = self::findWebAuthnProof(self::asArray($r['proof'] ?? null));

        if ($proof === null || $citizenDid === '') {
            $notes[] = 'Citizen assertion UNVERIFIABLE: no WebAuthn assertion or citizen DID on the receipt.';
            return 'fail';
        }
        $vm = self::asString($proof['verificationMethod'] ?? null);
        $coseHex = $this->resolveCoseKey($citizenDid, $vm);
        if ($coseHex === null) {
            $notes[] = "Citizen assertion UNVERIFIABLE: could not resolve the citizen DID {$citizenDid} (passkey {$vm}) "
                . '(network/resolution failure or key not found). This is INCONCLUSIVE, NOT a signature mismatch.';
            return 'unavailable';
        }

        try {
            $cose = Cose::parseKey(self::hexToBin($coseHex));
            $authData = self::base64UrlDecode(self::asString($proof['authenticatorData'] ?? null));
            $clientDataJSON = self::base64UrlDecode(self::asString($proof['clientDataJSON'] ?? null));
            $signature = self::base64UrlDecode(self::asString($proof['signature'] ?? null));
        } catch (Throwable) {
            $notes[] = 'Citizen assertion FAILED: the assertion artifacts could not be decoded.';
            return 'fail';
        }

        if ($cose['alg'] === 'unsupported') {
            $notes[] = 'Citizen assertion UNSUPPORTED: the passkey uses a COSE algorithm this offline verifier does not implement.';
            return 'unsupported';
        }

        $challenge = self::asString($proof['challenge'] ?? null);
        $challengeOk = self::challengeBinds($clientDataJSON, $challenge);
        $sigOk = Signature::verifyWebAuthnAssertion($cose, $authData, $clientDataJSON, $signature);

        if ($sigOk && $challengeOk) {
            $notes[] = "Citizen passkey assertion verified against {$vm}: the holder of the registered passkey signed over the "
                . "committed challenge {$challenge}.";
            $notes[] = 'This proves passkey POSSESSION over a committed challenge; it does NOT by itself prove the cell-level consent semantics.';
            return 'pass';
        }
        if (!$challengeOk) {
            $notes[] = 'Citizen assertion FAILED: the signed clientDataJSON challenge does not match the receipt challenge.';
        } else {
            $notes[] = 'Citizen assertion FAILED: the WebAuthn signature did not verify against the resolved passkey.';
        }
        return 'fail';
    }

    /**
     * @param array<array-key,mixed> $r
     * @param list<string> $notes
     */
    private function verifyDisclosureCopy(array $r, array &$notes): string
    {
        $consent = self::asObject(self::asObject($r['credentialSubject'] ?? null)['consent'] ?? null);
        $document = self::asObject($consent['document'] ?? null);
        $cid = self::asString($document['ipfsCid'] ?? null);
        $disclosureHash = self::asString($consent['disclosureHash'] ?? null);

        if ($cid === '' || $disclosureHash === '') {
            $notes[] = 'disclosureCopy skipped: the receipt carries no document.ipfsCid + disclosureHash pair to fetch and compare.';
            return 'skipped';
        }
        if (($this->opts['verifyDisclosure'] ?? true) === false) {
            $notes[] = 'disclosureCopy skipped: disclosure-copy verification was not requested.';
            return 'skipped';
        }

        $url = $this->ipfsGateway($cid);
        $bodyText = $this->httpGet($url);
        if ($bodyText === null) {
            $notes[] = "disclosureCopy could not be checked: fetching the IPFS body for CID {$cid} failed.";
            return 'skipped';
        }
        /** @var mixed $body */
        $body = json_decode($bodyText, true);
        $disclosure = self::asObject(self::asObject($body)['disclosure'] ?? null);
        $computed = '0x' . hash('sha256', $this->canonicalizer->encode($disclosure));
        if ($computed === $disclosureHash) {
            $notes[] = "Disclosure copy verified: the IPFS document body matches the receipt disclosureHash {$disclosureHash}.";
            return 'pass';
        }
        $notes[] = "disclosureCopy FAILED: the IPFS document body hashes to {$computed}, not the receipt disclosureHash {$disclosureHash}.";
        return 'fail';
    }

    /**
     * @param array<array-key,mixed> $r
     * @param list<string> $notes
     */
    private function verifyDocumentAnchor(array $r, array &$notes): string
    {
        $rpcUrl = self::asString($this->opts['rpcUrl'] ?? null);
        if ($rpcUrl === '') {
            $notes[] = 'documentAnchor skipped: pass an rpcUrl to check the on-chain document anchor.';
            return 'skipped';
        }
        $consent = self::asObject(self::asObject($r['credentialSubject'] ?? null)['consent'] ?? null);
        $cid = self::asString(self::asObject($consent['document'] ?? null)['ipfsCid'] ?? null);
        if ($cid === '') {
            $notes[] = 'documentAnchor skipped: the receipt carries no document.ipfsCid to look up on-chain.';
            return 'skipped';
        }

        $chainId = isset($this->opts['chainId']) && is_int($this->opts['chainId'])
            ? $this->opts['chainId']
            : self::DEFAULT_CHAIN_ID;
        $registry = isset($this->opts['registryAddress']) && is_string($this->opts['registryAddress'])
            ? $this->opts['registryAddress']
            : (self::REGISTRY_BY_CHAIN[$chainId] ?? null);
        if ($registry === null) {
            $notes[] = "documentAnchor skipped: no AgreelyRegistry address is known for chainId {$chainId}.";
            return 'skipped';
        }

        $topic = Keccak::hashHex('IdentityAnchored(bytes32,uint64)');
        $commitment = Keccak::hashHex($cid);
        $payload = (string) json_encode([
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'eth_getLogs',
            'params' => [[
                'address' => $registry,
                'fromBlock' => '0x0',
                'toBlock' => 'latest',
                'topics' => [$topic, $commitment],
            ]],
        ]);
        $responseText = $this->httpPost($rpcUrl, $payload);
        if ($responseText === null) {
            $notes[] = "documentAnchor could not be checked: the RPC call to {$rpcUrl} failed.";
            return 'skipped';
        }
        /** @var mixed $json */
        $json = json_decode($responseText, true);
        $logs = is_array($json) && isset($json['result']) && is_array($json['result']) ? $json['result'] : [];
        if (count($logs) > 0) {
            $notes[] = "Document anchor FOUND on chainId {$chainId}: CID {$cid} existed at anchor time. "
                . 'This proves the DOCUMENT existed, NOT that any consent was given.';
            return 'pass';
        }
        $notes[] = "documentAnchor FAILED: no on-chain anchor found for CID {$cid} on chainId {$chainId}.";
        return 'fail';
    }

    /**
     * Resolve a company slug to its did:web document (primitive).
     *
     * @return array<array-key,mixed>|null
     */
    public function resolveCompanyDid(string $slug): ?array
    {
        $host = self::asString($this->opts['companyDidHost'] ?? null) ?: self::DEFAULT_COMPANY_HOST;
        return $this->resolveDid("did:web:{$host}:c:{$slug}");
    }

    private function resolveEd25519Key(string $issuer, string $vmId): ?string
    {
        $doc = $this->resolveDid($issuer);
        $vm = self::pickVerificationMethod($doc, $vmId);
        $mb = self::asString($vm['publicKeyMultibase'] ?? null);
        if ($mb === '') {
            return null;
        }
        try {
            return Multibase::decodeEd25519PublicKey($mb);
        } catch (Throwable) {
            return null;
        }
    }

    private function resolveCoseKey(string $did, string $vmId): ?string
    {
        $doc = $this->resolveDid($did);
        $vm = self::pickVerificationMethod($doc, $vmId);
        $cose = self::asString($vm['publicKeyCose'] ?? null);
        return $cose === '' ? null : $cose;
    }

    /** @return array<array-key,mixed>|null */
    private function resolveDid(string $did): ?array
    {
        $resolver = $this->opts['resolver'] ?? null;
        if (is_callable($resolver)) {
            try {
                // A throwing resolver is a resolution FAILURE, not a tamper: null
                // flows through to an "unavailable" check, never a "fail".
                $doc = $resolver($did);
            } catch (Throwable) {
                return null;
            }
            return is_array($doc) ? $doc : null;
        }
        // Default HTTPS resolver: did:web -> /c/{slug}/did.json; did:agreely -> /did/{did}.
        if (str_starts_with($did, 'did:web:')) {
            $parts = explode(':', substr($did, strlen('did:web:')));
            $host = rawurldecode($parts[0]);
            $path = implode('/', array_map('rawurldecode', array_slice($parts, 1)));
            $url = "https://{$host}/{$path}/did.json";
        } else {
            $base = rtrim(self::asString($this->opts['citizenResolverBaseUrl'] ?? null) ?: self::DEFAULT_CITIZEN_BASE, '/');
            $url = "{$base}/did/" . rawurlencode($did);
        }
        $text = $this->httpGet($url);
        if ($text === null) {
            return null;
        }
        $doc = json_decode($text, true);
        return is_array($doc) ? $doc : null;
    }

    private function ipfsGateway(string $cid): string
    {
        $gw = $this->opts['ipfsGateway'] ?? null;
        if (is_callable($gw)) {
            $out = $gw($cid);
            return is_string($out) ? $out : self::DEFAULT_IPFS_GATEWAY . $cid;
        }
        return self::DEFAULT_IPFS_GATEWAY . $cid;
    }

    private function httpGet(string $url): ?string
    {
        $get = $this->opts['httpGet'] ?? null;
        if (is_callable($get)) {
            $out = $get($url);
            return is_string($out) ? $out : null;
        }
        return self::curl('GET', $url, null);
    }

    private function httpPost(string $url, string $body): ?string
    {
        $post = $this->opts['httpPost'] ?? null;
        if (is_callable($post)) {
            $out = $post($url, $body);
            return is_string($out) ? $out : null;
        }
        return self::curl('POST', $url, $body);
    }

    private static function curl(string $method, string $url, ?string $body): ?string
    {
        $ch = curl_init();
        $headers = ['Accept: application/json'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 15,
            ...($body !== null ? [CURLOPT_POSTFIELDS => $body] : []),
        ]);
        $result = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if (!is_string($result) || $status >= 400 || $status === 0) {
            return null;
        }
        return $result;
    }

    // --- helpers -------------------------------------------------------------

    /** @param array<array-key,mixed> $r */
    private static function receiptType(array $r): string
    {
        $types = self::asArray($r['type'] ?? null);
        foreach ($types as $t) {
            if ($t === 'CompanyAttestedConsentReceipt') {
                return 'company_attested';
            }
        }
        if (self::asString($r['assuranceLevel'] ?? null) === 'company_attested') {
            return 'company_attested';
        }
        return 'citizen';
    }

    /**
     * @param list<mixed> $proofs
     * @return array<array-key,mixed>|null
     */
    private static function findWebAuthnProof(array $proofs): ?array
    {
        foreach ($proofs as $p) {
            $obj = self::asObject($p);
            if (self::asString($obj['type'] ?? null) === 'WebAuthnAssertion') {
                return $obj;
            }
        }
        return null;
    }

    /**
     * @param array<array-key,mixed>|null $doc
     * @return array<array-key,mixed>|null
     */
    private static function pickVerificationMethod(?array $doc, string $vmId): ?array
    {
        if ($doc === null || !isset($doc['verificationMethod']) || !is_array($doc['verificationMethod'])) {
            return null;
        }
        $methods = array_values($doc['verificationMethod']);
        foreach ($methods as $m) {
            if (is_array($m) && ($m['id'] ?? null) === $vmId) {
                return $m;
            }
        }
        $first = $methods[0] ?? null;
        return is_array($first) ? $first : null;
    }

    private static function challengeBinds(string $clientDataJSON, string $receiptChallengeHex): bool
    {
        /** @var mixed $parsed */
        $parsed = json_decode($clientDataJSON, true);
        if (!is_array($parsed) || !isset($parsed['challenge']) || !is_string($parsed['challenge'])) {
            return false;
        }
        try {
            $fromClient = self::base64UrlDecode($parsed['challenge']);
            $fromReceipt = self::hexToBin($receiptChallengeHex);
        } catch (Throwable) {
            return false;
        }
        return hash_equals($fromReceipt, $fromClient);
    }

    private static function decideOverall(
        string $type,
        string $company,
        string $citizen,
        string $disclosure,
        string $anchor,
    ): string {
        if ($type === 'company_attested') {
            // An ACTIVE failure (a tamper / wrong key / bad disclosure) always wins:
            // a real negative verdict is never masked by an inconclusive resolution.
            if ($company === 'fail' || $disclosure === 'fail' || $anchor === 'fail') {
                return 'failed';
            }
            // The decisive check could not COMPLETE (DID unresolved): inconclusive.
            if ($company === 'unavailable') {
                return 'unavailable';
            }
            return 'verified';
        }
        if ($citizen === 'fail' || $disclosure === 'fail' || $anchor === 'fail') {
            return 'failed';
        }
        if ($citizen === 'unavailable') {
            return 'unavailable';
        }
        return 'partial';
    }

    private static function base64UrlDecode(string $input): string
    {
        $out = base64_decode(strtr($input, '-_', '+/'), true);
        if ($out === false) {
            throw new \RuntimeException('invalid base64url');
        }
        return $out;
    }

    private static function hexToBin(string $input): string
    {
        $hex = str_starts_with($input, '0x') || str_starts_with($input, '0X') ? substr($input, 2) : $input;
        if ($hex === '' || strlen($hex) % 2 !== 0 || preg_match('/[^0-9a-fA-F]/', $hex) === 1) {
            throw new \RuntimeException('invalid hex');
        }
        $out = hex2bin($hex);
        if ($out === false) {
            throw new \RuntimeException('invalid hex');
        }
        return $out;
    }

    /** @return array<array-key,mixed> */
    private static function asObject(mixed $v): array
    {
        if (!is_array($v)) {
            return [];
        }
        if ($v === []) {
            return []; // an empty JSON object {} decodes to [] — treat as empty object
        }
        return array_is_list($v) ? [] : $v; // a non-empty list is a JSON array, not an object
    }

    /** @return list<mixed> */
    private static function asArray(mixed $v): array
    {
        return is_array($v) && array_is_list($v) ? $v : [];
    }

    private static function asString(mixed $v): string
    {
        return is_string($v) ? $v : '';
    }
}
