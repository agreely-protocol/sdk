import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Agreely } from "../../src/index.js";
import type { DidDocument, ReceiptVerification, VerifyReceiptOptions } from "../../src/verify/types.js";
import { vectorChainFetch, type VectorAnswers } from "./registry.js";

// Shared by issuer-departure.json and live-dns.json: a receipt verified against a resolver whose issuer document a
// case may patch, a chain answering by selector, and the plain GETs (a departure record, a DNS-over-HTTPS query)
// answered by exact URL.

export const readVector = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../vectors/${rel}`, import.meta.url)), "utf8")) as T;

/** One GET answer: a status and a JSON body or a text. Null or absent: a network error. */
export type HttpAnswer = { status: number; body?: unknown; text?: string } | null;

export interface LiveCase {
  name: string;
  file: string;
  documents: string;
  issuerDocument: Record<string, unknown> | null;
  http: Record<string, HttpAnswer>;
  answers: VectorAnswers | null;
  options: Partial<VerifyReceiptOptions>;
  expect: Record<string, unknown>;
  asked: string[];
}

export function respond(answer: HttpAnswer | undefined): Response {
  if (answer === null || answer === undefined) throw new TypeError("fetch failed");
  const text = answer.text !== undefined ? answer.text : JSON.stringify(answer.body);
  return new Response(text, { status: answer.status });
}

/** Verifies a case's receipt; every GET is recorded with its headers, every POST goes to the chain. */
export async function verifyLive(c: LiveCase): Promise<{ result: ReceiptVerification; asked: string[]; headers: Headers[] }> {
  const bundle = readVector<{ receipt: { issuer: string } }>(c.file);
  const docs = structuredClone(readVector<Record<string, DidDocument>>(c.documents));
  const issuer = bundle.receipt.issuer;
  if (c.issuerDocument !== null) docs[issuer] = { ...docs[issuer]!, ...c.issuerDocument } as DidDocument;
  const chain = vectorChainFetch(c.answers ?? {});
  const asked: string[] = [];
  const headers: Headers[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") return chain.fetch(input, init);
    asked.push(String(input));
    headers.push(new Headers(init?.headers));
    return respond(c.http[String(input)]);
  }) as unknown as typeof fetch;
  const result = await Agreely.verifyReceipt(bundle, {
    resolver: (did) => docs[did] ?? null,
    fetch: fetchImpl,
    ...(c.answers !== null ? { rpcUrl: "https://rpc.test", chainId: 84532 } : {}),
    ...c.options,
  });
  return { result, asked, headers };
}
