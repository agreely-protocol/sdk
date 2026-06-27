import { describe, expect, it, vi } from "vitest";
import { Agreely, AgreelyConfigError, AgreelyUnavailableError } from "../../src/index.js";
import type { DegradeContext } from "../../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "http://api.test";
const DENY = { decision: "deny", status: "none", checkedAt: "t" };
const DOWN = { status: 503, json: { error: { code: "unavailable", message: "down" } } };

// 503 twice = a full outage (retry exhausts), the degrade path engages.
function outageScript() {
  return [DOWN, DOWN];
}

describe("fail-closed default (no config)", () => {
  it("check() denies on a 503 outage", async () => {
    const { fetch } = mockFetch(outageScript());
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    expect(await agreely.check("c", "Browsing/usage", "Analytics")).toBe(false);
  });

  it("checkDetailed() throws AgreelyUnavailableError on a 503 outage", async () => {
    const { fetch } = mockFetch(outageScript());
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    await expect(agreely.checkDetailed("c", "Browsing/usage", "Analytics")).rejects.toBeInstanceOf(
      AgreelyUnavailableError,
    );
  });

  it("per-call onOutage:'allow' WITHOUT config still denies", async () => {
    const { fetch } = mockFetch(outageScript());
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch });
    expect(await agreely.check("c", "Browsing/usage", "Analytics", { onOutage: "allow" })).toBe(false);
  });
});

describe("config init validation", () => {
  it("throws when mode is fail-open but onDegrade is missing", () => {
    expect(
      () =>
        new Agreely({
          apiKey: "k",
          baseUrl: BASE,
          // @ts-expect-error onDegrade intentionally omitted
          degradeOnOutage: { mode: "fail-open", categories: ["x"], maxOutageWindow: "5m" },
        }),
    ).toThrow(AgreelyConfigError);
  });
});

describe("fail-open: config allow-list + per-call gate (two gates)", () => {
  function failOpenClient(script: Parameters<typeof mockFetch>[0], onDegrade = vi.fn()) {
    const { fetch } = mockFetch(script);
    const agreely = new Agreely({
      apiKey: "k",
      baseUrl: BASE,
      fetch,
      degradeOnOutage: {
        mode: "fail-open",
        categories: ["Browsing/usage"],
        maxOutageWindow: "5m",
        onDegrade,
      },
    });
    return { agreely, onDegrade };
  }

  it("allows an allow-listed category WITH the per-call opt, and emits onDegrade", async () => {
    const onDegrade = vi.fn();
    const { agreely } = failOpenClient(outageScript(), onDegrade);
    const ok = await agreely.check("cust", "Browsing/usage", "Analytics", { onOutage: "allow" });
    expect(ok).toBe(true);
    expect(onDegrade).toHaveBeenCalledTimes(1);
    const ctx = onDegrade.mock.calls[0]![0] as DegradeContext;
    expect(ctx).toMatchObject({
      customerId: "cust",
      category: "Browsing/usage",
      purpose: "Analytics",
      mode: "fail-open",
      breakGlass: false,
    });
    expect(ctx.error).toBeInstanceOf(AgreelyUnavailableError);
    expect(ctx.at).toBeTruthy();
  });

  it("denies a category NOT in the allow-list even with the per-call opt (gate 1)", async () => {
    const onDegrade = vi.fn();
    const { agreely } = failOpenClient(outageScript(), onDegrade);
    expect(await agreely.check("cust", "Phone number", "Billing", { onOutage: "allow" })).toBe(false);
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("denies an allow-listed category WITHOUT the per-call opt (gate 2 — the per-call gate)", async () => {
    const onDegrade = vi.fn();
    const { agreely } = failOpenClient(outageScript(), onDegrade);
    expect(await agreely.check("cust", "Browsing/usage", "Analytics")).toBe(false);
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("matches the allow-list tolerant of casing/whitespace (local policy key, NOT wire normalization)", async () => {
    const { agreely } = failOpenClient(outageScript());
    expect(await agreely.check("cust", "  browsing/USAGE ", "Analytics", { onOutage: "allow" })).toBe(true);
  });

  it("checkDetailed returns a degraded allow (degraded:true, mode fail-open)", async () => {
    const { agreely } = failOpenClient(outageScript());
    const r = await agreely.checkDetailed("cust", "Browsing/usage", "Analytics", { onOutage: "allow" });
    expect(r.decision).toBe("allow");
    expect(r.degraded).toBe(true);
    expect(r.mode).toBe("fail-open");
  });

  it("refuses to degrade past maxOutageWindow (fail closed again)", async () => {
    const onDegrade = vi.fn();
    // Every call is an outage. The window is tiny so the 2nd degrade is refused.
    const { fetch } = mockFetch([DOWN]);
    const agreely = new Agreely({
      apiKey: "k",
      baseUrl: BASE,
      fetch,
      timeout: 50,
      degradeOnOutage: {
        mode: "fail-open",
        categories: ["Browsing/usage"],
        maxOutageWindow: "10ms",
        onDegrade,
      },
    });
    // First degraded allow opens the window.
    expect(await agreely.check("c", "Browsing/usage", "Analytics", { onOutage: "allow" })).toBe(true);
    await new Promise((r) => setTimeout(r, 25)); // exceed the 10ms window
    expect(await agreely.check("c", "Browsing/usage", "Analytics", { onOutage: "allow" })).toBe(false);
  });
});

describe("a 200 deny is NEVER degraded", () => {
  it("returns the real deny even with fail-open config + per-call opt", async () => {
    const onDegrade = vi.fn();
    const { fetch } = mockFetch([{ json: DENY }]);
    const agreely = new Agreely({
      apiKey: "k",
      baseUrl: BASE,
      fetch,
      degradeOnOutage: { mode: "fail-open", categories: ["Browsing/usage"], maxOutageWindow: "5m", onDegrade },
    });
    expect(await agreely.check("c", "Browsing/usage", "Analytics", { onOutage: "allow" })).toBe(false);
    expect(onDegrade).not.toHaveBeenCalled();
  });
});

describe("break-glass (gate 3, independent operator override)", () => {
  function bgClient(script: Parameters<typeof mockFetch>[0], onBreakGlass = vi.fn(), onDegrade = vi.fn()) {
    const { fetch } = mockFetch(script);
    const agreely = new Agreely({
      apiKey: "k",
      baseUrl: BASE,
      fetch,
      onBreakGlass,
      // a config (empty allow-list) so degraded checks emit through onDegrade
      degradeOnOutage: { mode: "fail-open", categories: [], maxOutageWindow: "1h", onDegrade },
    });
    return { agreely, onBreakGlass, onDegrade };
  }

  it("engage without a reason throws", async () => {
    const { agreely } = bgClient(outageScript());
    expect(() => agreely.breakGlass.engage({ reason: "  ", ttl: "30m" })).toThrow(AgreelyConfigError);
  });

  it("allows a degraded check within scope while engaged, tagged breakGlass:true", async () => {
    const { agreely, onBreakGlass, onDegrade } = bgClient(outageScript());
    agreely.breakGlass.engage({ reason: "incident-42", ttl: "30m", scope: ["Browsing/usage"] });
    expect(onBreakGlass).toHaveBeenCalledWith(expect.objectContaining({ action: "engage", reason: "incident-42" }));
    const ok = await agreely.check("c", "Browsing/usage", "Analytics");
    expect(ok).toBe(true);
    expect(onDegrade.mock.calls[0]![0]).toMatchObject({ mode: "break-glass", breakGlass: true, reason: "incident-42" });
  });

  it("does NOT allow a category outside the engaged scope", async () => {
    const { agreely } = bgClient(outageScript());
    agreely.breakGlass.engage({ reason: "incident-42", ttl: "30m", scope: ["Browsing/usage"] });
    expect(await agreely.check("c", "Phone number", "Billing")).toBe(false);
  });

  it("expires after ttl (auto fail-closed again) and audits the expiry", async () => {
    const onBreakGlass = vi.fn();
    const { fetch } = mockFetch([DOWN, DOWN, DOWN, DOWN]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch, timeout: 20, onBreakGlass });
    agreely.breakGlass.engage({ reason: "x", ttl: "150ms" });
    expect(await agreely.check("c", "anything", "p")).toBe(true);
    await new Promise((r) => setTimeout(r, 220));
    expect(await agreely.check("c", "anything", "p")).toBe(false);
    expect(onBreakGlass).toHaveBeenCalledWith(expect.objectContaining({ action: "expire" }));
  });

  it("disengage stands down and audits", async () => {
    const onBreakGlass = vi.fn();
    const { fetch } = mockFetch([DOWN, DOWN, DOWN, DOWN]);
    const agreely = new Agreely({ apiKey: "k", baseUrl: BASE, fetch, onBreakGlass });
    agreely.breakGlass.engage({ reason: "x", ttl: "30m" });
    agreely.breakGlass.disengage();
    expect(await agreely.check("c", "anything", "p")).toBe(false);
    expect(onBreakGlass).toHaveBeenCalledWith(expect.objectContaining({ action: "disengage" }));
  });

  it("break-glass overrides even when the category is not in the config allow-list", async () => {
    // config allow-list is empty; break-glass still allows (independent gate).
    const { agreely } = bgClient(outageScript());
    agreely.breakGlass.engage({ reason: "incident", ttl: "30m" }); // no scope = all
    expect(await agreely.check("c", "Some Sensitive Cat", "p")).toBe(true);
  });
});
