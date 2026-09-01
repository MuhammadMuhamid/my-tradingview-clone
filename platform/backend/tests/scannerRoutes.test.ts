import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import { scannerRoutes, scannerConfigPatch } from "../src/api/routes/scanner";
import { scannerRequest, ScannerServiceError } from "../src/scanner/client";
import { SESSION_COOKIE, signSession } from "../src/security/session";
import type { LiveRunner } from "../src/engine/liveRunner";

const MARKET = {
  exchange: "binanceusdm", market_type: "usd_m_perpetual", contract_type: "perpetual",
  linear: true, spot: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

test("Scanner client preserves canonical Futures identity and sends no browser credentials", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ market: MARKET, rows: [] });
  }) as typeof fetch;
  const result = await scannerRequest<{ market: typeof MARKET }>({ method: "GET", path: "/api/screener" }, {
    baseUrl: "http://scanner.internal:8000", fetchImpl,
  });
  assert.deepEqual(result.market, MARKET);
  assert.equal(calls[0]?.url, "http://scanner.internal:8000/api/screener");
  assert.deepEqual(calls[0]?.init?.headers, { accept: "application/json" });
  assert.equal(JSON.stringify(calls).toLowerCase().includes("authorization"), false);
  assert.equal(JSON.stringify(calls).toLowerCase().includes("spot"), false);
});

test("Scanner boundary forwards only approved timeframe writes and validation details", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(scannerRoutes);
  t.after(() => app.close());
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body?.toString() });
    if (String(url).endsWith("/api/config")) return jsonResponse({ detail: "bad timeframe" }, 422);
    return jsonResponse({ ok: true, market: MARKET });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const refresh = await app.inject({ method: "POST", url: "/api/scanner/refresh?force=true" });
  assert.equal(refresh.statusCode, 200);
  assert.equal(calls[0]?.url, "http://127.0.0.1:8000/api/refresh?force=true");

  const patch = await app.inject({ method: "PATCH", url: "/api/scanner/config",
    payload: { indicators: { rsi: { timeframe: "15m" } } } });
  assert.equal(patch.statusCode, 422);
  assert.equal(patch.json().error, "bad timeframe");
  assert.equal(calls[1]?.body, JSON.stringify({ indicators: { rsi: { timeframe: "15m" } } }));

  const strategyMutation = await app.inject({ method: "PATCH", url: "/api/scanner/config",
    payload: { strategy: { rsi_level: 55 } } });
  assert.equal(strategyMutation.statusCode, 400);
  assert.match(strategyMutation.json().error, /unsupported field/);
  assert.throws(() => scannerConfigPatch({ scoring: { weights: { trend: 99 } } }),
    (error: unknown) => error instanceof ScannerServiceError && error.status === 400);

  const arbitrary = await app.inject({ method: "GET", url: "/api/scanner/proxy/api/config" });
  assert.equal(arbitrary.statusCode, 404);
  assert.equal(calls.length, 2);
});

test("Scanner unavailable maps to a bounded 503 without exposing an internal URL", async () => {
  await assert.rejects(
    scannerRequest({ method: "GET", path: "/api/screener" }, { baseUrl: "" }),
    (error: unknown) => error instanceof ScannerServiceError && error.status === 503 &&
      error.message === "Scanner service is not configured",
  );
  await assert.rejects(
    scannerRequest({ method: "GET", path: "/api/screener" }, {
      baseUrl: "http://secret-scanner.internal:8000",
      fetchImpl: (async () => { throw new Error("connect ECONNREFUSED secret-scanner.internal"); }) as typeof fetch,
      timeoutMs: 10,
    }),
    (error: unknown) => error instanceof ScannerServiceError && error.status === 503 &&
      error.message === "Scanner service is unavailable" && !error.message.includes("internal"),
  );
});

test("Platform session gate protects Scanner reads and permits a signed owner session", async (t) => {
  const previous = {
    authEnabled: config.authEnabled, adminUsername: config.adminUsername,
    sessionSecret: config.sessionSecret,
  };
  config.authEnabled = true;
  config.adminUsername = "owner";
  config.sessionSecret = "scanner-route-test-session-secret-000000000000";
  t.after(() => Object.assign(config, previous));

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return jsonResponse({ market: MARKET, rows: [] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const app = buildServer(() => ({} as LiveRunner));
  t.after(() => app.close());
  const denied = await app.inject({ method: "GET", url: "/api/scanner" });
  assert.equal(denied.statusCode, 401);
  assert.equal(fetches, 0);

  const token = signSession("owner", config.sessionSecret);
  const allowed = await app.inject({ method: "GET", url: "/api/scanner",
    headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.json().market, MARKET);
  assert.equal(fetches, 1);
  assert.match(String(allowed.headers["set-cookie"]), new RegExp(`^${SESSION_COOKIE}=`));
});
