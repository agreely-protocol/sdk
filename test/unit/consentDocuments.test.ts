import { describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyConfigError,
  AgreelyNotFoundError,
  AgreelyUnavailableError,
  AgreelyValidationError,
  DOCUMENT_TIMEOUT_MS,
  type ConsentDocumentDetail,
  type ConsentDocumentSummary,
} from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const VERSION = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

function client(script: Parameters<typeof mockFetch>[0], timeout?: number) {
  const { fetch, calls } = mockFetch(script);
  return { agreely: new Agreely({ apiKey: "k", baseUrl: BASE, fetch, ...(timeout ? { timeout } : {}) }), calls };
}

const summary: ConsentDocumentSummary = {
  code: "conditions-marketing",
  documentVersionId: VERSION,
  version: "3",
  name: "Conditions marketing",
  nameEn: null,
  effectiveDate: "2026-10-01",
  publishedAt: "2026-10-01T12:00:00Z",
  items: [
    { id: "c1", category: "Courriel", categoryEn: "Email", purpose: "Infolettre", purposeEn: null, sensitive: false },
  ],
};

const text = { fr: "Texte", en: null };
const detail: ConsentDocumentDetail = {
  ...summary,
  disclosure: {
    purpose: text,
    means: text,
    categories: text,
    retention: text,
    withdrawal: text,
    recipients: text,
    crossBorder: text,
    rights: text,
  },
  responsable: { name: "Responsable", contact: "privacy@example.com" },
  automatedDecision: { declared: false, note: text },
  profiling: { declared: false, note: text },
  integrity: { ipfsCid: null, anchorStatus: "none" },
};

const PDF = new TextEncoder().encode("%PDF-1.7 information");

describe("consentDocuments.list / get", () => {
  it("lists the published documents, unwrapping `documents`", async () => {
    const { agreely, calls } = client([{ json: { documents: [summary] } }]);
    expect(await agreely.consentDocuments.list()).toEqual([summary]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/v1/consent-documents`);
  });

  it("gets one document by its code, encoded, unwrapping `document`", async () => {
    const { agreely, calls } = client([{ json: { document: detail } }]);
    const d = await agreely.consentDocuments.get(" conditions marketing ");
    expect(d.disclosure.crossBorder).toEqual(text);
    expect(calls[0]!.url).toBe(`${BASE}/v1/consent-documents/conditions%20marketing`);
  });

  it("refuses a blank code before any call, and maps a miss to AgreelyNotFoundError", async () => {
    const { agreely, calls } = client([{ status: 404, json: { error: { code: "not_found", message: "none" } } }]);
    await expect(agreely.consentDocuments.get("  ")).rejects.toBeInstanceOf(AgreelyConfigError);
    expect(calls).toHaveLength(0);
    await expect(agreely.consentDocuments.get("other-tenant")).rejects.toBeInstanceOf(AgreelyNotFoundError);
  });

  it("retries a read once on a transient 503", async () => {
    const { agreely, calls } = client([{ status: 503 }, { json: { documents: [] } }], 2000);
    expect(await agreely.consentDocuments.list()).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe("consentDocuments.getInformationPdf", () => {
  it("returns the bytes, the suggested filename and the type, asking for French by default", async () => {
    const { agreely, calls } = client([
      {
        bytes: PDF,
        headers: { "Content-Disposition": 'attachment; filename="agreely-document-information-3-fr.pdf"' },
      },
    ]);
    const doc = await agreely.consentDocuments.getInformationPdf(VERSION.toUpperCase());
    expect(Buffer.from(doc.pdf).toString()).toBe("%PDF-1.7 information");
    expect(doc.filename).toBe("agreely-document-information-3-fr.pdf");
    expect(doc.contentType).toBe("application/pdf");
    expect(calls[0]!.url).toBe(`${BASE}/v1/consent-documents/versions/${VERSION}/pdf?locale=fr`);
    expect(calls[0]!.headers.Accept).toContain("application/pdf");
  });

  it("asks for English when told, and surfaces english_text_missing as a typed 422 on locale", async () => {
    const { agreely, calls } = client([
      {
        status: 422,
        json: { error: { code: "english_text_missing", message: "No English text.", field: "locale" } },
      },
    ]);
    const err = await agreely.consentDocuments.getInformationPdf(VERSION, { locale: "en" }).catch((e: unknown) => e);
    expect(calls[0]!.url).toContain("locale=en");
    expect(err).toBeInstanceOf(AgreelyValidationError);
    expect(err).toMatchObject({ code: "english_text_missing", field: "locale", status: 422 });
  });

  it("refuses a non-uuid version id and a locale outside fr/en before any call", async () => {
    const { agreely, calls } = client([{ bytes: PDF }]);
    await expect(agreely.consentDocuments.getInformationPdf("conditions-marketing")).rejects.toBeInstanceOf(
      AgreelyConfigError,
    );
    await expect(
      agreely.consentDocuments.getInformationPdf(VERSION, { locale: "de" as "fr" }),
    ).rejects.toBeInstanceOf(AgreelyConfigError);
    expect(calls).toHaveLength(0);
  });

  it("maps a draft, unknown or foreign version (one 404 body) to AgreelyNotFoundError", async () => {
    const { agreely } = client([{ status: 404, json: { error: { code: "not_found", message: "none" } } }]);
    await expect(agreely.consentDocuments.getInformationPdf(VERSION)).rejects.toBeInstanceOf(AgreelyNotFoundError);
  });

  it("gives the render a budget of its own, above a check-sized client timeout", async () => {
    expect(DOCUMENT_TIMEOUT_MS).toBe(15_000);
    // The client budget (40 ms) would cut a 120 ms render off; the render floor does not.
    const { agreely } = client([{ bytes: PDF, delayMs: 120 }], 40);
    const doc = await agreely.consentDocuments.getInformationPdf(VERSION);
    expect(doc.pdf.byteLength).toBe(PDF.byteLength);
  });

  it("honours a per-call timeout, and refuses a nonsensical one", async () => {
    const { agreely } = client([{ bytes: PDF, delayMs: 200 }, { bytes: PDF, delayMs: 200 }]);
    await expect(agreely.consentDocuments.getInformationPdf(VERSION, { timeout: 30 })).rejects.toBeInstanceOf(
      AgreelyUnavailableError,
    );
    await expect(agreely.consentDocuments.getInformationPdf(VERSION, { timeout: 0 })).rejects.toBeInstanceOf(
      AgreelyConfigError,
    );
  });
});
