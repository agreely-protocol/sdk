<?php

declare(strict_types=1);

namespace Agreely\Sdk\Verify;

/**
 * The full, honest result of an offline receipt verification — the PHP twin of
 * the TS SDK's ReceiptVerification. HONESTY IS THE POINT: each field reports what
 * was PROVED vs merely trusted, and `overall` never overstates it (a citizen
 * receipt is at most "partial" offline).
 *
 * Statuses are strings: 'pass' | 'fail' | 'unavailable' | 'skipped' | 'unsupported'
 * ('unavailable' = the DID could not be resolved, so the check could not complete —
 * distinct from 'fail', a real signature mismatch). overall: 'verified' | 'partial'
 * | 'failed' | 'unavailable'. receiptType: 'company_attested' | 'citizen'.
 */
final class ReceiptVerification
{
    /** @param list<string> $notes */
    public function __construct(
        public readonly string $receiptType,
        public readonly string $companySignature,
        public readonly string $citizenAssertion,
        public readonly string $disclosureCopy,
        public readonly string $documentAnchor,
        public readonly string $cellLabelBinding,
        public readonly string $overall,
        public readonly array $notes,
    ) {
    }

    /**
     * The array form, in the SAME field shape as the TS ReceiptVerification, so
     * BOTH SDKs canonicalize to byte-identical JCS (the golden-vector discipline).
     *
     * @return array{receiptType:string,companySignature:string,citizenAssertion:string,disclosureCopy:string,documentAnchor:string,cellLabelBinding:string,overall:string,notes:list<string>}
     */
    public function toArray(): array
    {
        return [
            'receiptType' => $this->receiptType,
            'companySignature' => $this->companySignature,
            'citizenAssertion' => $this->citizenAssertion,
            'disclosureCopy' => $this->disclosureCopy,
            'documentAnchor' => $this->documentAnchor,
            'cellLabelBinding' => $this->cellLabelBinding,
            'overall' => $this->overall,
            'notes' => $this->notes,
        ];
    }
}
