// Recorded receipts (paper, telephone) as the web verifier classifies them (public/assets/verify/verify-core.js
// receiptModeOf, recordedVersionOf, signedAnchorOf; ui.js recordedRootBinding). Versions 1 to 3 never carry an anchor;
// a version 4 signs its anchor batch (credentialSubject.consent.merkleRoot, consentRefs). Vector: vectors/recorded-v4.json.

const RECORDED_SPEC = {
  company_attested: {
    typeToken: "CompanyAttestedConsentReceipt",
    evidenceType: "HandSignedPaperConsent",
    consentKeys: new Set([
      "action", "items", "documentVersion", "document", "effectiveDate", "grantedAt",
      "recordedAt", "issuerDeclaration", "declinedItems", "confirms", "merkleRoot", "consentRefs",
    ]),
    evidenceKeys: new Set(["type", "pdfHash", "pdfHeldBy", "documentVersion", "documentVersionMatch"]),
  },
  company_documented: {
    typeToken: "VerbalConsentReceipt",
    evidenceType: "VerbalConsentDocumentedByOrganisation",
    consentKeys: new Set([
      "action", "channel", "items", "documentVersion", "document", "grantedAt",
      "recordedAt", "issuerDeclaration", "declinedItems", "merkleRoot", "consentRefs",
    ]),
    evidenceKeys: new Set(["type", "scriptVersion", "documentVersion"]),
  },
} as const;

const RECORDED_TOP_LEVEL_KEYS = new Set([
  "receiptVersion", "@context", "type", "id", "issuer", "assuranceLevel", "validFrom",
  "validUntil", "credentialSubject", "evidence", "proof",
]);

const BYTES32_HEX = /^0x[0-9a-f]{64}$/;

export type RecordedType = keyof typeof RECORDED_SPEC;

const own = (o: unknown, k: string): boolean =>
  o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>): boolean => Object.keys(o).every((k) => allowed.has(k));

/**
 * Is this recorded receipt the shape its issuer writes, for a version this verifier reads?
 *   ok              the members of its type and version, and nothing else;
 *   mismatch        a member its type or version never carries, or one it must carry missing (a version 3 with an
 *                   anchor included): `reason` says which;
 *   unknown-version a receiptVersion this verifier does not read.
 * The proof array is judged on its own (recordedProofFailure) and is not part of this answer.
 */
export function recordedShapeOf(
  r: Record<string, unknown>,
  type: RecordedType,
): { kind: "ok" } | { kind: "mismatch"; reason: string } | { kind: "unknown-version"; version: string } {
  const spec = RECORDED_SPEC[type];
  const types = Array.isArray(r["type"]) ? (r["type"] as unknown[]) : [];
  const other = RECORDED_SPEC[type === "company_attested" ? "company_documented" : "company_attested"];
  if (!types.includes("ConsentReceipt") || !types.includes(spec.typeToken) || r["assuranceLevel"] !== type) {
    return { kind: "mismatch", reason: `its type and assuranceLevel do not both name a ${type} receipt` };
  }
  if (types.includes(other.typeToken)) return { kind: "mismatch", reason: "its type names both a paper and a telephone receipt" };
  if (!onlyKeys(r, RECORDED_TOP_LEVEL_KEYS)) return { kind: "mismatch", reason: "it carries a top-level member the issuer never writes" };
  const subject = r["credentialSubject"];
  if (!isPlainObject(subject) || !onlyKeys(subject, new Set(["consent"]))) {
    return { kind: "mismatch", reason: "its credentialSubject carries a member other than consent" };
  }
  const consent = subject["consent"];
  if (!isPlainObject(consent) || !onlyKeys(consent, spec.consentKeys)) {
    return { kind: "mismatch", reason: "its consent carries a member the issuer never writes" };
  }
  if (consent["action"] !== "grant") return { kind: "mismatch", reason: "its consent action is not grant" };
  if (type === "company_documented" && consent["channel"] !== "telephone") {
    return { kind: "mismatch", reason: "its consent channel is not telephone" };
  }
  const evidence = r["evidence"];
  if (!isPlainObject(evidence) || !onlyKeys(evidence, spec.evidenceKeys) || evidence["type"] !== spec.evidenceType) {
    return { kind: "mismatch", reason: "its evidence is not the evidence of its type" };
  }
  const hasRecordedAt = own(consent, "recordedAt");
  const hasDeclaration = own(consent, "issuerDeclaration");
  const hasAnchor = own(consent, "merkleRoot") || own(consent, "consentRefs");
  const recordedAtOk = typeof consent["recordedAt"] === "string";
  if (!own(r, "receiptVersion")) {
    return !hasRecordedAt && !hasDeclaration && !hasAnchor
      ? { kind: "ok" }
      : { kind: "mismatch", reason: "a receipt without a receiptVersion carries a member only a later version writes" };
  }
  const v = r["receiptVersion"];
  if (v === "2") {
    return recordedAtOk && !hasDeclaration && !hasAnchor
      ? { kind: "ok" }
      : { kind: "mismatch", reason: "a version 2 receipt carries a member it never writes, or lacks its recordedAt" };
  }
  if (v === "3" || v === "4") {
    if (!recordedAtOk) return { kind: "mismatch", reason: `a version ${v} receipt lacks its recordedAt` };
    if (v === "3" && hasAnchor) return { kind: "mismatch", reason: "a version 3 receipt carries an anchor, which only a version 4 signs" };
    return !hasDeclaration || isPlainObject(consent["issuerDeclaration"])
      ? { kind: "ok" }
      : { kind: "mismatch", reason: "its issuerDeclaration is not an object" };
  }
  return { kind: "unknown-version", version: typeof v === "string" ? v : JSON.stringify(v) ?? String(v) };
}

/**
 * The anchor batch a version 4 receipt signs. Null for any other version; wellFormed false when a member is missing
 * or malformed (the root and every ref 0x + 64 lowercase hex, at least one ref, no duplicate).
 */
export function signedAnchorOf(r: Record<string, unknown>): { wellFormed: boolean; merkleRoot: string; consentRefs: string[] } | null {
  const subject = r["credentialSubject"];
  const consent = isPlainObject(subject) ? subject["consent"] : null;
  if (r["receiptVersion"] !== "4" || !isPlainObject(consent)) return null;
  const root = consent["merkleRoot"];
  const refs = consent["consentRefs"];
  const malformed = { wellFormed: false, merkleRoot: "", consentRefs: [] };
  if (typeof root !== "string" || !BYTES32_HEX.test(root)) return malformed;
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((x) => typeof x === "string" && BYTES32_HEX.test(x))) return malformed;
  if (new Set(refs).size !== refs.length) return malformed;
  return { wellFormed: true, merkleRoot: root, consentRefs: (refs as string[]).slice() };
}

export type SignedAnchorBinding = "bound" | "contradicts" | "malformed" | "preV4";

/**
 * What a recorded receipt's own signature says about the anchor its bundle ships, once that signature held:
 *   bound        the envelope root equals the signed root and every envelope ref is a signed ref;
 *   contradicts  the envelope root differs, or the envelope carries a ref the signature does not;
 *   malformed    a version 4 missing or malforming a member, or a bundle with no envelope root: no anchor is tied;
 *   preV4        signed before version 4: no anchor is tied.
 * Fewer envelope refs than signed ones is no contradiction: the chain read takes the signed list.
 */
export function recordedRootBinding(
  r: Record<string, unknown>,
  bundle: Record<string, unknown>,
  envelopeRefs: string[],
): { binding: SignedAnchorBinding; merkleRoot: string; consentRefs: string[] } {
  const signed = signedAnchorOf(r);
  if (signed === null) return { binding: "preV4", merkleRoot: "", consentRefs: [] };
  if (!signed.wellFormed) return { binding: "malformed", merkleRoot: "", consentRefs: [] };
  const anchor = { merkleRoot: signed.merkleRoot, consentRefs: signed.consentRefs };
  const signedRefs = new Set(signed.consentRefs);
  const rogueRef = envelopeRefs.some((ref) => !signedRefs.has(ref));
  // A null or empty root is no root: nothing is tied. Only a value that differs contradicts.
  const raw = own(bundle, "merkleRoot") ? bundle["merkleRoot"] : undefined;
  const shipped = raw === null || raw === "" ? undefined : raw;
  const rootDiffers =
    shipped !== undefined &&
    (typeof shipped !== "string" || "0x" + shipped.replace(/^0x/i, "").toLowerCase() !== signed.merkleRoot);
  if (rogueRef || rootDiffers) return { binding: "contradicts", ...anchor };
  if (shipped === undefined) return { binding: "malformed", merkleRoot: "", consentRefs: [] };
  return { binding: "bound", ...anchor };
}
