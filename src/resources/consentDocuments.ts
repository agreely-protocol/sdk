import { AgreelyConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import type {
  ConsentDocumentDetail,
  ConsentDocumentSummary,
  DocumentLocale,
  InformationDocument,
  InformationDocumentOptions,
} from "../types.js";
import { assertUuid, renderBudget } from "../util.js";

/**
 * The floor of the time budget for a call that renders a PDF (ms). The client default
 * (800 ms) is sized for the consent check on a request path, not for a render.
 */
export const DOCUMENT_TIMEOUT_MS = 15_000;

interface ListWire {
  documents: ConsentDocumentSummary[];
}

interface DetailWire {
  document: ConsentDocumentDetail;
}

/**
 * The consent-document resource: read-only discovery of the organisation's PUBLISHED
 * consent documents, so an integration resolves the `documentVersionId` that manual
 * and verbal consents and consent sheets take, instead of copying it out of a browser.
 * Authoring and publishing stay in Agreely.
 *
 * Scopes: `list` and `get` accept 'check' or 'issue'; `getInformationPdf` also accepts
 * 'attest' and 'attest_verbal'.
 */
export class ConsentDocuments {
  constructor(
    private readonly transport: Transport,
    private readonly clientTimeoutMs: number,
  ) {}

  /** Every published document, each with the active catalog cells its version groups. */
  async list(): Promise<ConsentDocumentSummary[]> {
    const wire = await this.transport.request<ListWire>({
      method: "GET",
      path: "/v1/consent-documents",
      idempotentRetry: true,
    });
    return wire.documents;
  }

  /**
   * One published document with its full disclosure, resolved by its STABLE code (pin
   * the code, and resolve the current `documentVersionId` through it). An unknown code
   * and another tenant's are the same AgreelyNotFoundError.
   */
  async get(code: string): Promise<ConsentDocumentDetail> {
    const value = typeof code === "string" ? code.trim() : "";
    if (value === "") throw new AgreelyConfigError("consentDocuments.get requires a document code.");
    const wire = await this.transport.request<DetailWire>({
      method: "GET",
      path: `/v1/consent-documents/${encodeURIComponent(value)}`,
      idempotentRetry: true,
    });
    return wire.document;
  }

  /**
   * The INFORMATION DOCUMENT of one version, as PDF bytes to print and hand to the
   * person, with the signature sheet or on its own. By VERSION id, never by code: the
   * version a consent is recorded against is the one whose text she must be given. A
   * version superseded since its publication is served too (and says so); a draft never
   * is, and a draft, an unknown and another tenant's id are the same AgreelyNotFoundError.
   *
   * English is refused with a 422 (code `english_text_missing`) when a section of the
   * version has no English text, rather than printed without it. The bytes are not
   * frozen (the letterhead follows the organisation's logo): store your own copy, keyed
   * on (documentVersionId, locale). Fetching it records nothing: it is not evidence that
   * anyone was informed. A read; safe to auto-retry on a transient outage.
   */
  async getInformationPdf(
    documentVersionId: string,
    options: InformationDocumentOptions = {},
  ): Promise<InformationDocument> {
    const label = "consentDocuments.getInformationPdf";
    const versionId = assertUuid(documentVersionId, `${label}: documentVersionId`);
    const locale = assertLocale(options.locale, label);
    const res = await this.transport.requestBytes({
      method: "GET",
      path: `/v1/consent-documents/versions/${versionId}/pdf`,
      query: { locale },
      idempotentRetry: true,
      timeoutMs: renderBudget(options.timeout, this.clientTimeoutMs, DOCUMENT_TIMEOUT_MS, label),
    });
    return {
      pdf: res.bytes,
      filename: attachmentFilename(res.contentDisposition),
      contentType: res.contentType ?? "application/pdf",
    };
  }
}

/** "fr" (the default) or "en"; anything else is refused before the wire call. */
export function assertLocale(locale: unknown, label: string): DocumentLocale {
  if (locale === undefined) return "fr";
  if (locale !== "fr" && locale !== "en") {
    throw new AgreelyConfigError(`${label}: locale must be "fr" or "en".`);
  }
  return locale;
}

/** The quoted filename of a Content-Disposition header, or null. */
function attachmentFilename(header: string | null): string | null {
  const match = header !== null ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? null;
}
