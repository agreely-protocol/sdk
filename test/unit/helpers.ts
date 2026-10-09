import { vi } from "vitest";

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponseSpec {
  status?: number;
  json?: unknown;
  /** A raw binary body (a PDF) instead of `json`. */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  /** Throw a network/abort error instead of responding. */
  throw?: Error;
  /** Answer only after this many ms, aborting like a real fetch when the signal fires first. */
  delayMs?: number;
}

/**
 * A scripted fetch mock. Each entry is consumed in order; a function entry can
 * inspect the call. Records every call for assertions. Mirrors just enough of
 * the Fetch API for the transport.
 */
export function mockFetch(script: Array<MockResponseSpec | ((call: MockCall) => MockResponseSpec)>) {
  const calls: MockCall[] = [];
  let i = 0;

  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers = normalizeHeaders(init?.headers);
    const call: MockCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);

    const entry = script[Math.min(i, script.length - 1)];
    i++;
    const spec = typeof entry === "function" ? entry(call) : entry;
    if (!spec) throw new Error("mockFetch: no scripted response");
    if (spec.throw) throw spec.throw;
    if (spec.delayMs !== undefined) await delay(spec.delayMs, init?.signal ?? undefined);

    const status = spec.status ?? 200;
    if (spec.bytes !== undefined) {
      return new Response(spec.bytes, {
        status,
        headers: { "Content-Type": "application/pdf", ...spec.headers },
      });
    }
    const bodyText = spec.json === undefined ? "" : JSON.stringify(spec.json);
    return new Response(bodyText, {
      status,
      headers: { "Content-Type": "application/json", ...spec.headers },
    });
  });

  return { fetch: fn as unknown as typeof fetch, calls };
}

function normalizeHeaders(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k] = v));
  } else if (Array.isArray(h)) {
    for (const pair of h) out[String(pair[0])] = String(pair[1]);
  } else {
    Object.assign(out, h);
  }
  return out;
}

/** Wait `ms`, rejecting with an AbortError the moment the signal fires (as fetch does). */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export function networkError(): Error {
  return new TypeError("fetch failed");
}
