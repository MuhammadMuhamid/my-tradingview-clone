/**
 * NOTIFICATION ALERTS NEVER MOVE MONEY.
 *
 * Price and MA alerts and automated strategy execution are two different
 * promises. They share a database and a websocket manager, and it would be an
 * easy, quiet mistake to give the alert runner a helper that also happens to
 * reach a deployment or a webhook. Discovering that had happened by receiving
 * an unexpected order is not acceptable, so the boundary is asserted here
 * rather than left to review.
 *
 * The check walks the alert runner's ENTIRE transitive import graph, not just
 * its direct imports: a forbidden module reached three hops away places exactly
 * the same order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

/** Modules that can place an order, notify the bot, or start a deployment. */
const FORBIDDEN = [
  "alerts/dispatcher.ts",       // POSTs webhook orders to the execution bot
  "contract/webhookContract.ts",// the order payload vocabulary itself
  "engine/broker.ts",           // fills and position accounting
  "engine/liveRunner.ts",       // the automated strategy loop
  "engine/liveEvaluator.ts",
  "engine/mtfLeanLiveEvaluator.ts",
  "engine/srTrendLiveEvaluator.ts",
  "repositories/deployments.ts",
  "repositories/liveSafety.ts",
];

/** Resolve a relative import specifier to a file under src/, or null. */
function resolve(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` by relative import, including itself. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    // Covers `import x from "…"`, `import type … from "…"`, `export … from "…"`
    // and `import("…")`, which is every form this codebase uses.
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolve(file, m[1]!);
      if (next) queue.push(next);
    }
  }
  return seen;
}

const relative = (f: string): string => path.relative(SRC, f).split(path.sep).join("/");

test("THE ALERT RUNNER CANNOT REACH A DEPLOYMENT, A WEBHOOK ORDER OR AN EXCHANGE", () => {
  const closure = importClosure(path.join(SRC, "engine", "maAlertRunner.ts"));
  const reachable = new Set([...closure].map(relative));

  const violations = FORBIDDEN.filter((f) => reachable.has(f));
  assert.deepEqual(
    violations, [],
    `the alert runner can now reach ${violations.join(", ")} — an alert must only notify`
  );
});

test("the alert HTTP routes cannot reach one either", () => {
  const closure = importClosure(path.join(SRC, "api", "routes", "maAlerts.ts"));
  const reachable = new Set([...closure].map(relative));
  assert.deepEqual(FORBIDDEN.filter((f) => reachable.has(f)), []);
});

test("the guard is real: it detects a forbidden module when one IS reachable", () => {
  // Without this, a broken resolver would report a clean graph forever. The
  // live runner genuinely does reach the dispatcher, so it is the honest probe.
  const closure = importClosure(path.join(SRC, "engine", "liveRunner.ts"));
  const reachable = new Set([...closure].map(relative));
  assert.ok(
    FORBIDDEN.some((f) => reachable.has(f)),
    "the import walker found nothing forbidden from liveRunner.ts, so it is not working"
  );
});

test("the only Binance endpoints on the alert path are public market data", () => {
  const closure = importClosure(path.join(SRC, "engine", "maAlertRunner.ts"));
  for (const file of closure) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/\/api\/v3\/([a-zA-Z]+)/g)) {
      assert.ok(
        ["klines", "exchangeInfo", "ticker", "depth", "time"].includes(m[1]!),
        `${relative(file)} reaches /api/v3/${m[1]} — not a public market-data endpoint`
      );
    }
    // A signed request is the precondition for every account or order call.
    assert.doesNotMatch(
      source, /X-MBX-APIKEY|createHmac\(\s*["']sha256["']\s*,\s*\w*[sS]ecret/,
      `${relative(file)} builds a signed Binance request`
    );
  }
});

test("a forming candle is never written to the candle store", () => {
  // The intrabar frequencies are fed by 'barUpdate'. If that path ever persisted
  // its candle, every later read — backtests, indicators, the chart — would be
  // reading a bar that never existed.
  const source = fs.readFileSync(path.join(SRC, "data", "binanceWs.ts"), "utf8");
  const barUpdate = source.slice(source.indexOf('if (!k.x) {'));
  const beforeClose = barUpdate.slice(0, barUpdate.indexOf("return;"));
  assert.doesNotMatch(beforeClose, /upsertCandles/);
  // And the closed-bar path still does persist, so the check above is not
  // passing merely because persistence was removed altogether.
  assert.match(source, /await upsertCandles\(\[candle\]\);/);
});
