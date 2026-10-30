// Two live readings about a receipt's issuer, as the Agreely /verify page makes them, and no stricter or looser:
//
//   - its departure from Agreely: /c/{slug}/departure.json, asked only once the issuer's DID document says
//     deactivated (public/assets/verify/did.js readIssuerDeparture, departurePhaseOf; ui.js departureShownFor);
//   - its domain's live DNS declaration: the TXT record at _agreely.<domain>, read over DNS-over-HTTPS and compared
//     with the key the registry names for that domain today (issuer.js liveDnsRecheck).
//
// Pure: receipt.ts makes the two requests.

import type { CompanyKeyVerdict, IssuerDepartureReading, LiveDnsStatus } from "./types.js";

/** The DNS-over-HTTPS JSON resolver the /verify page asks. It answers JSON only to `accept: application/dns-json`. */
export const DEFAULT_DOH_URL = "https://cloudflare-dns.com/dns-query";

/**
 * did:web:<host>:c:<slug> -> https://<host>/c/<slug>/departure.json, beside its did.json. Null for any other DID
 * shape: only an Agreely company DID has a departure record.
 */
export function departureUrlOf(did: unknown): string | null {
  if (typeof did !== "string" || !did.startsWith("did:web:")) return null;
  let parts: string[];
  try {
    parts = did.slice("did:web:".length).split(":").map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  const host = parts.shift();
  if (!host || parts.length === 0) return null;
  const match = /^(https:\/\/[^/]+\/c\/[^/]+)\/did\.json$/.exec(`https://${host}/${parts.join("/")}/did.json`);
  return match ? match[1] + "/departure.json" : null;
}

/** A civil day that exists: Date rolls 2026-02-31 over to March, so the day must read back unchanged. */
export function isCivilDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

/**
 * The departure a record establishes: a purged record naming this exact issuer DID, with two real civil days in
 * order. Null for anything else (another DID, another status, a day that is not real, days reversed, not an object).
 */
export function departureRecordOf(body: unknown, issuer: string): { sealedOn: string; purgedOn: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const { sealedOn, purgedOn } = record;
  if (record["did"] !== issuer || record["status"] !== "purged") return null;
  if (!isCivilDay(sealedOn) || !isCivilDay(purgedOn) || sealedOn > purgedOn) return null;
  return { sealedOn, purgedOn };
}

/**
 * Where a signing instant (milliseconds since the epoch, NaN when it does not parse) falls against a departure. The
 * record carries the company's civil days and the instant is absolute, so the instant is read on its UTC day and the
 * red bound is padded by a day: 'after' only when that day is strictly after purgedOn + 1, which a receipt signed
 * before the purge cannot reach from any time zone. 'before' when the day precedes sealedOn, 'during' otherwise.
 */
export function departurePhaseOf(
  record: { sealedOn: string; purgedOn: string },
  signedAtMs: number,
): NonNullable<IssuerDepartureReading["phase"]> {
  if (!Number.isFinite(signedAtMs)) return "unknown";
  const day = new Date(signedAtMs).toISOString().slice(0, 10);
  const dayAfterPurge = new Date(Date.parse(record.purgedOn + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  if (day > dayAfterPurge) return "after";
  return day < record.sealedOn ? "before" : "during";
}

/**
 * Whether a departure speaks for the issuer. The record and the deactivated document both come from the issuer DID's
 * own host, which a forger can run: before or during the departure they count only once the registry confirmed the
 * company key. A receipt dated after the purge keeps its departure whatever the registry says: it can only turn that
 * host's own receipt red.
 */
export function departureCounts(reading: IssuerDepartureReading | undefined, companyKey: CompanyKeyVerdict | undefined): boolean {
  if (reading === undefined || reading.state !== "departed") return false;
  return reading.phase === "after" || companyKey === "authentic";
}

/** The DNS-over-HTTPS query for the TXT record at _agreely.<domain>. */
export function liveDnsQueryUrl(resolver: string, domain: string): string {
  return `${resolver}?name=${encodeURIComponent("_agreely." + domain)}&type=TXT`;
}

/**
 * The resolver's JSON answer against the key the registry names for the domain today. No TXT answer is
 * 'not-resolvable' (a placeholder domain, or a zone with no record); TXT answers none of which declares
 * key=<that key> are 'not-declared'. A TXT split into several strings is joined first.
 */
export function liveDnsStatusOf(json: unknown, keyId: string): Exclude<LiveDnsStatus, "unreachable"> {
  const answer = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["Answer"] : undefined;
  const txts = (Array.isArray(answer) ? answer : [])
    .filter((a: unknown) => {
      const type = typeof a === "object" && a !== null ? (a as Record<string, unknown>)["type"] : undefined;
      return type === 16 || type === "16";
    })
    .map((a: Record<string, unknown>) => String(a["data"] || "").replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  if (txts.length === 0) return "not-resolvable";
  const want = keyId.replace(/^0x/i, "").toLowerCase();
  for (const txt of txts) {
    const m = /key\s*=\s*([0-9a-fA-F]{64})/.exec(txt);
    if (m && m[1]!.toLowerCase() === want) return "confirmed";
  }
  return "not-declared";
}
