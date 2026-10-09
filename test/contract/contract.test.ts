import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Agreely,
  AgreelyAuthError,
  AgreelyConflictError,
  AgreelyRateLimitError,
  AgreelyValidationError,
  type CheckResult,
} from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const fixturePath = resolve(here, "fixture.json");
const goldenPath = resolve(here, "../../vectors/vectors.json");

interface Fixture {
  baseUrl: string;
  /**
   * `all` is OPTIONAL: a key carrying every scope (attest, withdraw, registry, holds,
   * ...). The seed does not mint one; add it to the fixture to run the write routes.
   */
  keys: { check: string; issue: string; both: string; otherTenantCheck: string; all?: string };
  subject: string;
  absent: string;
  revocable: { category: string; purpose: string; consentRef: string };
  issue: {
    catalogId: string;
    category: string;
    purpose: string;
    documentId: string;
    documentCode: string;
    recipientEmail: string;
    validUntil: string;
  };
}

interface Golden {
  checks: Array<{
    name: string;
    subject: "active" | "absent";
    category: string;
    purpose: string;
    expect: { decision: string; status: string; consentRefPresent: boolean };
  }>;
  errors: Array<{
    name: string;
    scope: "check" | "issue" | "bad";
    method: string;
    path: string;
    body: Record<string, unknown>;
    expect: { status: number; code: string; field?: string };
  }>;
}

const hasFixture = existsSync(fixturePath);
const fixture: Fixture | null = hasFixture
  ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture)
  : null;
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;

const REQUEST_ID = /^0x[0-9a-f]{64}$/;
const CONSENT_REF = /^0x[0-9a-f]+$/;

/** Assert an object has exactly the contract's keys (openapi additionalProperties:false). */
function assertExactKeys(obj: Record<string, unknown>, required: string[], optional: string[] = []) {
  for (const key of required) expect(obj, `missing required key ${key}`).toHaveProperty(key);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    expect(allowed.has(key), `unexpected key "${key}" (not in openapi contract)`).toBe(true);
  }
}

// The suite is gated on a seeded fixture AND an explicit opt-in: it drives the
// LIVE /v1 API (stateful, rate-limited), so it is OFF by default and the default
// `npm test` (test/unit) stays deterministic and green. Run it with
// `AGREELY_LIVE=1 npm run test:contract` once the stack + fixture are up; without
// either, the suite skips cleanly rather than failing on live drift / a 429.
const runLive = hasFixture && process.env.AGREELY_LIVE === "1";
const suite = runLive ? describe : describe.skip;

suite("contract: @agreely/sdk vs the live /v1 API", () => {
  let agreely: Agreely;

  beforeAll(() => {
    agreely = new Agreely({ apiKey: fixture!.keys.check, baseUrl: fixture!.baseUrl });
  });

  describe("golden vector checks (shared with the PHP SDK)", () => {
    for (const vec of golden.checks) {
      it(vec.name, async () => {
        const customerId = vec.subject === "active" ? fixture!.subject : fixture!.absent;
        const r: CheckResult = await agreely.checkDetailed(customerId, vec.category, vec.purpose);
        // Shape vs openapi CheckDecision.
        assertExactKeys(
          r as unknown as Record<string, unknown>,
          ["decision", "status", "checkedAt"],
          ["consentRef", "assurance", "tier", "basis", "validUntil", "revokedAt"],
        );
        expect(r.decision).toBe(vec.expect.decision);
        expect(r.status).toBe(vec.expect.status);
        if (vec.expect.consentRefPresent) {
          expect(r.consentRef).toMatch(CONSENT_REF);
          // A record-backed answer carries the end of its consent, as an RFC 3339 UTC instant.
          expect(r.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        } else {
          expect(r.consentRef).toBeUndefined();
          // No record, no dates: the keys are absent, never null.
          expect(r).not.toHaveProperty("validUntil");
          expect(r).not.toHaveProperty("revokedAt");
        }
        // The boolean gate agrees with the decision.
        expect(await agreely.check(customerId, vec.category, vec.purpose)).toBe(
          vec.expect.decision === "allow",
        );
      });
    }
  });

  describe("golden error vectors", () => {
    for (const vec of golden.errors) {
      it(vec.name, async () => {
        const token =
          vec.scope === "bad" ? "agr_live_" + "z".repeat(43) : fixture!.keys[vec.scope];
        const res = await fetch(fixture!.baseUrl + vec.path, {
          method: vec.method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(vec.body),
        });
        expect(res.status).toBe(vec.expect.status);
        const body = (await res.json()) as { error: { code: string; message: string; field?: string } };
        // openapi Error envelope: { error: { code, message, field? } }, no extras.
        assertExactKeys(body as unknown as Record<string, unknown>, ["error"]);
        assertExactKeys(body.error as unknown as Record<string, unknown>, ["code", "message"], ["field"]);
        expect(body.error.code).toBe(vec.expect.code);
        if (vec.expect.field) expect(body.error.field).toBe(vec.expect.field);
      });
    }
  });

  describe("typed errors map from the live API", () => {
    it("an issue-only key throws AgreelyAuthError (forbidden) from check", async () => {
      const issueClient = new Agreely({ apiKey: fixture!.keys.issue, baseUrl: fixture!.baseUrl });
      await expect(issueClient.checkDetailed(fixture!.subject, "Email Address", "Marketing Outreach"))
        .rejects.toMatchObject({ name: "AgreelyAuthError", code: "forbidden", status: 403 });
    });

    it("a bad key throws AgreelyAuthError (401)", async () => {
      const bad = new Agreely({ apiKey: "agr_live_" + "z".repeat(43), baseUrl: fixture!.baseUrl });
      await expect(bad.catalog.list()).rejects.toBeInstanceOf(AgreelyAuthError);
    });

    it("an empty purpose throws AgreelyValidationError naming the field", async () => {
      await expect(agreely.checkDetailed(fixture!.subject, "Email Address", ""))
        .rejects.toMatchObject({ name: "AgreelyValidationError", field: "purpose" });
      await expect(agreely.checkDetailed(fixture!.subject, "Email Address", "")).rejects.toBeInstanceOf(
        AgreelyValidationError,
      );
    });
  });

  describe("revoke-then-check: instant deny, no chain wait", () => {
    // The out-of-band revoke runs the seed script inside the API stack, so it needs the
    // directory of that stack's docker-compose file: AGREELY_APP_DIR. Skipped without it.
    const appDir = process.env.AGREELY_APP_DIR;
    it.skipIf(appDir === undefined)("allows, then denies on the very next call after an out-of-band revoke", async () => {
      const { category, purpose, consentRef } = fixture!.revocable;
      expect(await agreely.check(fixture!.subject, category, purpose)).toBe(true);

      // Flip the enforcement record out-of-band, in-container.
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "api", "php", "scripts/sdk-contract-seed.php", "revoke", consentRef],
        { cwd: resolve(repoRoot, appDir ?? "."), stdio: "pipe" },
      );

      const after = await agreely.checkDetailed(fixture!.subject, category, purpose);
      expect(after.decision).toBe("deny");
      expect(after.status).toBe("revoked");
    });
  });

  describe("tenant isolation", () => {
    it("another tenant's key cannot read this company's grant", async () => {
      const other = new Agreely({ apiKey: fixture!.keys.otherTenantCheck, baseUrl: fixture!.baseUrl });
      const r = await other.checkDetailed(fixture!.subject, "Email Address", "Marketing Outreach");
      // A granted this (subject, labels); B did not. A leak would show allow.
      expect(r.decision).toBe("deny");
      expect(r.status).toBe("none");
    });
  });

  describe("identity (GET /v1/whoami)", () => {
    it("returns the key's scopes and the tenant's public identity, nothing else (least disclosure)", async () => {
      const identity = await agreely.identity();
      assertExactKeys(identity as unknown as Record<string, unknown>, ["scopes", "company"]);
      assertExactKeys(identity.company as unknown as Record<string, unknown>, [
        "name",
        "sector",
        "statute",
        "publicPolicyUrl",
      ]);
      expect(identity.scopes).toContain("check");
      // No company id, DID, key metadata or counters leak into the body.
      const raw = JSON.stringify(identity);
      expect(raw).not.toMatch(/"(id|companyId|did|plan|usage)"/);

      const issuer = new Agreely({ apiKey: fixture!.keys.issue, baseUrl: fixture!.baseUrl });
      expect((await issuer.identity()).scopes).toContain("issue");
    });

    it("rejects a bad key with AgreelyAuthError (401)", async () => {
      const bad = new Agreely({ apiKey: "agr_live_" + "z".repeat(43), baseUrl: fixture!.baseUrl });
      await expect(bad.identity()).rejects.toBeInstanceOf(AgreelyAuthError);
    });
  });

  describe("cancel (POST /v1/consent-requests/{id}/cancel)", () => {
    it("cancels a pending request, then is idempotent on the terminal state", async () => {
      const issuer = new Agreely({ apiKey: fixture!.keys.issue, baseUrl: fixture!.baseUrl });
      const created = await issuer.consentRequests.create({
        customerId: fixture!.subject,
        recipientEmail: fixture!.issue.recipientEmail,
        consentDocumentId: fixture!.issue.documentId,
        validUntil: fixture!.issue.validUntil,
      });

      const cancelled = await issuer.consentRequests.cancel(created.requestId);
      assertExactKeys(cancelled as unknown as Record<string, unknown>, ["requestId", "status", "cancelled"]);
      expect(cancelled.requestId).toBe(created.requestId);
      expect(cancelled.status).toBe("revoked_before_action");
      expect(cancelled.cancelled).toBe(true);

      // Idempotent: a second cancel is not an error and reports cancelled:false.
      const again = await issuer.consentRequests.cancel(created.requestId);
      expect(again.cancelled).toBe(false);
      expect(again.status).toBe("revoked_before_action");
    });

    it("maps an unknown request to AgreelyNotFoundError (404)", async () => {
      const issuer = new Agreely({ apiKey: fixture!.keys.issue, baseUrl: fixture!.baseUrl });
      await expect(issuer.consentRequests.cancel("0x" + "a".repeat(64))).rejects.toMatchObject({
        name: "AgreelyNotFoundError",
        status: 404,
      });
    });
  });

  describe("catalog discovery", () => {
    it("lists the company's active catalog (shape vs openapi CatalogEntry)", async () => {
      const both = new Agreely({ apiKey: fixture!.keys.both, baseUrl: fixture!.baseUrl });
      const entries = await both.catalog.list();
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        assertExactKeys(e as unknown as Record<string, unknown>, [
          "id",
          "category",
          "purpose",
          "description",
          "legalBasis",
          "sensitive",
        ]);
      }
      expect(entries.some((e) => e.id === fixture!.issue.catalogId)).toBe(true);
    });
  });

  describe("consent documents (a check key reads them)", () => {
    it("lists the published document, resolves it by code, and serves its information PDF", async () => {
      const documents = await agreely.consentDocuments.list();
      const listed = documents.find((d) => d.code === fixture!.issue.documentCode);
      expect(listed).toBeDefined();
      expect(listed!.documentVersionId).toBe(fixture!.issue.documentId);
      assertExactKeys(listed as unknown as Record<string, unknown>, [
        "code",
        "documentVersionId",
        "version",
        "name",
        "nameEn",
        "effectiveDate",
        "publishedAt",
        "items",
      ]);

      const detail = await agreely.consentDocuments.get(fixture!.issue.documentCode);
      expect(detail.documentVersionId).toBe(fixture!.issue.documentId);
      expect(detail.disclosure).toHaveProperty("crossBorder");

      const pdf = await agreely.consentDocuments.getInformationPdf(fixture!.issue.documentId);
      expect(Buffer.from(pdf.pdf.subarray(0, 5)).toString()).toBe("%PDF-");
      expect(pdf.contentType).toContain("application/pdf");
    });

    it("answers an unknown version with AgreelyNotFoundError", async () => {
      await expect(
        agreely.consentDocuments.getInformationPdf("00000000-0000-4000-8000-000000000000"),
      ).rejects.toMatchObject({ name: "AgreelyNotFoundError", status: 404 });
    });
  });

  describe("issuance + idempotency replay (no double-issue)", () => {
    it("creates a request, then replays it byte-for-byte under the same Idempotency-Key", async () => {
      const issuer = new Agreely({ apiKey: fixture!.keys.issue, baseUrl: fixture!.baseUrl });
      const input = {
        customerId: fixture!.subject,
        recipientEmail: fixture!.issue.recipientEmail,
        consentDocumentId: fixture!.issue.documentId,
        validUntil: fixture!.issue.validUntil,
      };
      const key = "sdk-contract-" + Math.random().toString(36).slice(2);

      const first = await issuer.consentRequests.create(input, { idempotencyKey: key });
      assertExactKeys(
        first as unknown as Record<string, unknown>,
        ["requestId", "status", "deepLink", "emailDelivered", "items", "document"],
      );
      expect(first.document.code).toBe(fixture!.issue.documentCode);
      expect(first.requestId).toMatch(REQUEST_ID);
      expect(first.status).toBe("pending");

      const replay = await issuer.consentRequests.create(input, { idempotencyKey: key });
      expect(replay.requestId).toBe(first.requestId); // same handle, nothing new issued

      // get() by the PROTOCOL requestId (not a uuid).
      const got = await issuer.consentRequests.get(first.requestId);
      expect(got.requestId).toBe(first.requestId);
      assertExactKeys(
        got as unknown as Record<string, unknown>,
        ["requestId", "status", "validUntil", "expiresAt", "createdAt", "settledAt", "customerId", "documentCode", "items", "document"],
      );

      // list() surfaces it; the page maps the wire `requests` field to `items`.
      const page = await issuer.consentRequests.list({ status: "pending" });
      expect(page).toHaveProperty("items");
      expect(page).toHaveProperty("nextCursor");
      expect(page.items.some((r) => r.requestId === first.requestId)).toBe(true);

      // The customerId + status + limit filters narrow the page, and the record
      // carries the new customerId/documentCode metadata.
      const filtered = await issuer.consentRequests.list({
        customerId: fixture!.subject,
        status: "pending",
        limit: 100,
      });
      const mine = filtered.items.find((r) => r.requestId === first.requestId);
      expect(mine).toBeDefined();
      expect(mine!.customerId).toBe(fixture!.subject);
      expect(mine!.documentCode).toBe(fixture!.issue.documentCode);

      // hasPending is the dedup helper: a pending request exists for this customer.
      expect(await issuer.consentRequests.hasPending(fixture!.subject)).toBe(true);
      expect(
        await issuer.consentRequests.hasPending(fixture!.subject, fixture!.issue.documentCode),
      ).toBe(true);
    });

    it("resolves a documentCode to the published version server-side", async () => {
      const issuer = new Agreely({ apiKey: fixture!.keys.issue, baseUrl: fixture!.baseUrl });
      const created = await issuer.consentRequests.create({
        customerId: fixture!.subject,
        recipientEmail: fixture!.issue.recipientEmail,
        documentCode: fixture!.issue.documentCode,
        validUntil: fixture!.issue.validUntil,
      });
      expect(created.requestId).toMatch(REQUEST_ID);
      expect(created.document.code).toBe(fixture!.issue.documentCode);
      expect(created.items[0]).toMatchObject({
        category: fixture!.issue.category,
        purpose: fixture!.issue.purpose,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The write routes, end to end, with customer refs holding "/" and "%41". They need a
// key carrying every scope (`keys.all` in the fixture), which the seed does not mint:
// without it they are SKIPPED, and the suite says so out loud rather than silently.
// ---------------------------------------------------------------------------

const allKey = fixture?.keys.all;
if (runLive && allKey === undefined) {
  console.warn(
    "[contract] keys.all is missing from the fixture: the write-route suite (withdrawal, consent sheet, " +
      "holds, holds feed, customer upsert) is SKIPPED. Add a key carrying every scope as keys.all.",
  );
}
const writeSuite = runLive && allKey !== undefined ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Re-send a call (with its fixed Idempotency-Key) after a per-minute 429, so a long seed rides the window. */
async function paced<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof AgreelyRateLimitError) || error.code !== "rate_limited") throw error;
      await sleep(((error.retryAfterSeconds ?? 1) + 0.2) * 1000);
    }
  }
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

writeSuite("contract: the write routes, with refs holding a slash and %41", () => {
  let a: Agreely;
  const run = Math.random().toString(36).slice(2, 8);
  const slashRef = `SDK/${run}/0042`;
  const percentRef = `sdk-${run}%41`;

  beforeAll(() => {
    a = new Agreely({ apiKey: allKey!, baseUrl: fixture!.baseUrl, timeout: 15_000 });
  });

  it("the stack hands an encoded slash to the API (it is not refused by the web server)", async () => {
    const res = await fetch(`${fixture!.baseUrl}/v1/customers/a%2Fb`);
    expect(res.headers.get("content-type") ?? "", "an HTML 404 means the web server refused %2F").toContain(
      "application/json",
    );
    expect(res.status).toBe(401);
  });

  it("customers.upsert creates, then merges, and a ref with a slash or %41 reads back exactly as written", async () => {
    for (const ref of [slashRef, percentRef]) {
      const created = await a.customers.upsert(ref, { displayName: "Contract Person", legalBasis: "contract" });
      expect(created.created).toBe(true);
      expect(created.customerRef).toBe(ref);
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

      const merged = await a.customers.upsert(ref, { displayName: null });
      expect(merged.created).toBe(false);
      expect(merged.hasDisplayName).toBe(false);
      expect(merged.legalBasis).toBe("contract");

      const read = await a.customers.get(ref);
      expect(read.customerRef).toBe(ref);
    }
    // "%41" must not have been decoded into "A" on the way: that would be another customer.
    await expect(a.customers.get(percentRef.replace("%41", "A"))).rejects.toMatchObject({ status: 404 });
  });

  it("a consent sheet for a ref with a slash is minted once; its key then answers already_minted", async () => {
    await a.customers.upsert(slashRef, { legalBasis: "contract" });
    const key = `contract-sheet-${run}`;
    const sheet = await a.manualConsents.createConsentSheet(
      slashRef,
      { documentVersionId: fixture!.issue.documentId },
      { idempotencyKey: key },
    );
    expect(Buffer.from(sheet.signatureSheet.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(sheet.printedReference).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(sheet.claim.claimUrl).toMatch(/^https?:\/\//);

    const replay = await a.manualConsents
      .createConsentSheet(slashRef, { documentVersionId: fixture!.issue.documentId }, { idempotencyKey: key })
      .catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(AgreelyConflictError);
    expect(replay).toMatchObject({ code: "already_minted", reason: "already_minted" });
  });

  it("a withdrawal recorded on behalf, for a ref with a slash and %41, denies at once and replays on repeat", async () => {
    const customerRef = `SDK/${run}/wd%41`;
    const recorded = await a.manualConsents.record({
      customerId: customerRef,
      documentVersionId: fixture!.issue.documentId,
      effectiveDate: isoDay(-1),
      validUntil: isoDay(365),
      items: [fixture!.issue.catalogId],
      evidence: { pdfSha256: Agreely.hashPdf(new TextEncoder().encode(`%PDF-1.7 contract ${run}`)) },
      versionAttested: true,
    });
    const consentRef = recorded.consentRefs.find((ref) => !recorded.acknowledged.some((l) => l.consentRef === ref));
    expect(consentRef).toMatch(CONSENT_REF);

    const before = await a.checkDetailed(customerRef, fixture!.issue.category, fixture!.issue.purpose);
    expect(before.decision).toBe("allow");

    const w = await a.withdrawals.record(customerRef, consentRef!, { channel: "mail", operator: "contract-op" });
    assertExactKeys(w as unknown as Record<string, unknown>, [
      "consentRef",
      "withdrawn",
      "alreadyWithdrawn",
      "recordedOnBehalf",
      "assurance",
      "gate",
      "alsoWithdrawn",
    ]);
    expect(w).toMatchObject({ withdrawn: true, alreadyWithdrawn: false, recordedOnBehalf: true, assurance: "company_attested", gate: "denied" });

    const after = await a.checkDetailed(customerRef, fixture!.issue.category, fixture!.issue.purpose);
    expect(after).toMatchObject({ decision: "deny", status: "revoked" });
    expect(after.revokedAt).toMatch(/Z$/);

    const again = await a.withdrawals.record(customerRef, consentRef!, { channel: "mail", operator: "contract-op" });
    expect(again).toMatchObject({ alreadyWithdrawn: true, gate: "unchanged" });

    // Another customer's ref never reaches this consent: the same 404 as an unknown one.
    await expect(
      a.withdrawals.record(slashRef, consentRef!, { channel: "mail", operator: "contract-op" }),
    ).rejects.toMatchObject({ status: 404, reason: "unknown_consent" });
  });

  it("a hold on a ref with %41 is placed, fed, released, and a second release is already_released", async () => {
    await a.customers.upsert(percentRef, { legalBasis: "contract" });
    const placed = await a.retention.placeHold(
      percentRef,
      { ground: "other_law", provision: "Contract test provision, s. 1" },
      { idempotencyKey: `contract-hold-${run}` },
    );
    expect(placed).toMatchObject({ customerRef: percentRef, status: "active", placedBy: "api", replayed: false });

    const replay = await a.retention.placeHold(
      percentRef,
      { ground: "other_law", provision: "Contract test provision, s. 1" },
      { idempotencyKey: `contract-hold-${run}` },
    );
    expect(replay).toMatchObject({ id: placed.id, replayed: true });

    const snapshot = await a.retention.syncHolds();
    expect(snapshot.mode).toBe("snapshot");
    expect(snapshot.holds.find((h) => h.id === placed.id)).toMatchObject({ customerRef: percentRef, status: "active" });

    const retention = await a.retention.getCustomerRetention(percentRef);
    expect(retention.holds.some((h) => h.id === placed.id && h.status === "active")).toBe(true);

    const released = await a.retention.releaseHold(percentRef, placed.id, { reason: "Contract test over" });
    expect(released).toMatchObject({ id: placed.id, status: "released", customerRef: percentRef });

    await expect(a.retention.releaseHold(percentRef, placed.id, { reason: "again" })).rejects.toMatchObject({
      status: 409,
      code: "already_released",
    });

    const delta = await a.retention.syncHolds({ changedSince: snapshot.cursor });
    expect(delta.mode).toBe("delta");
    expect(delta.holds.find((h) => h.id === placed.id)).toMatchObject({ status: "released" });
  });

  // Paging needs more than 500 holds, placed through the API at 120 requests a minute:
  // about five minutes. Opt in with AGREELY_LIVE_PAGING=1 (on a fresh fixture: the API
  // places at most 1,000 holds a day per company).
  const paging = process.env.AGREELY_LIVE_PAGING === "1";
  if (!paging) console.warn("[contract] AGREELY_LIVE_PAGING is not set: the holds-feed paging test is SKIPPED.");
  it.skipIf(!paging)(
    "the holds feed pages past 500 holds: every page but the last has a token, only the last has the cursor",
    async () => {
      const perRef = 46; // the server allows 50 active holds per customer
      const refs = Array.from({ length: 11 }, (_, i) => `SDK/${run}/page/${i}`);
      const placedIds = new Set<string>();
      for (const ref of refs) {
        await paced(() => a.customers.upsert(ref, { legalBasis: "contract" }));
        for (let n = 0; n < perRef; n++) {
          const hold = await paced(() =>
            a.retention.placeHold(ref, { ground: "rights_request" }, { idempotencyKey: `contract-page-${run}-${ref}-${n}` }),
          );
          placedIds.add(hold.id);
        }
      }
      expect(placedIds.size).toBe(refs.length * perRef);

      const pages = [];
      for await (const page of a.retention.holdPages()) pages.push(page);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      for (const page of pages.slice(0, -1)) {
        expect(page.holds).toHaveLength(500);
        expect(typeof page.nextPageToken).toBe("string");
        expect(page.cursor).toBeNull();
      }
      const last = pages[pages.length - 1]!;
      expect(last.nextPageToken).toBeNull();
      expect(typeof last.cursor).toBe("string");

      const seen = new Set(pages.flatMap((p) => p.holds.map((h) => h.id)));
      for (const id of placedIds) expect(seen.has(id)).toBe(true);
      const sync = await a.retention.syncHolds();
      expect(new Set(sync.holds.map((h) => h.id)).size).toBe(seen.size);
    },
    600_000,
  );
});
