/**
 * PAPER MODE CANNOT PLACE AN ORDER.
 *
 * A simulation that could reach the dispatcher would be a live deployment with
 * a friendlier label, and the failure would look exactly like a successful
 * paper run right up to the moment real money moved. So the separation is
 * structural — `engine/paperBroker.ts` is a pure function that imports nothing
 * able to place an order — and it is asserted here over the module's ENTIRE
 * transitive import graph rather than left to review.
 *
 * This mirrors `tests/alertIsolation.test.ts`, which pins the same property for
 * notification alerts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

/** Modules that can place an order, notify the bot, or reach a credential. */
const FORBIDDEN = [
  "alerts/dispatcher.ts",        // POSTs webhook orders to the execution bot
  "contract/webhookContract.ts", // the order payload vocabulary itself
  "engine/liveRunner.ts",        // the automated strategy loop
  "engine/liveEvaluator.ts",
  "engine/mtfLeanLiveEvaluator.ts",
  "engine/srTrendLiveEvaluator.ts",
  "repositories/deployments.ts", // holds the encrypted webhook secret
  "security/secrets.ts",
  "data/binanceRest.ts",
  "data/binanceWs.ts",
];

function resolve(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolve(file, m[1]!);
      if (next) queue.push(next);
    }
  }
  return seen;
}

const relative = (f: string): string => path.relative(SRC, f).split(path.sep).join("/");

test("THE PAPER SIMULATOR CANNOT REACH A DISPATCHER, A CREDENTIAL OR AN EXCHANGE", () => {
  const reachable = new Set([...importClosure(path.join(SRC, "engine", "paperBroker.ts"))].map(relative));
  const violations = FORBIDDEN.filter((f) => reachable.has(f));
  assert.deepEqual(
    violations, [],
    `the paper simulator can now reach ${violations.join(", ")} — a simulation must not move money`
  );
});

test("it imports nothing at all, in fact", () => {
  const closure = importClosure(path.join(SRC, "engine", "paperBroker.ts"));
  assert.equal(closure.size, 1, "paperBroker.ts must stay a pure module with no local imports");
});

test("the fill recorder reaches the database and nothing that can order", () => {
  const reachable = new Set([...importClosure(path.join(SRC, "repositories", "paperFills.ts"))].map(relative));
  assert.deepEqual(FORBIDDEN.filter((f) => reachable.has(f)), []);
  assert.ok(reachable.has("db/pool.ts"), "it does write to the database");
});

test("the guard is real: it detects a forbidden module when one IS reachable", () => {
  // Without this, a broken resolver would report a clean graph for ever. The
  // live runner genuinely does reach the dispatcher, so it is the honest probe.
  const reachable = new Set([...importClosure(path.join(SRC, "engine", "liveRunner.ts"))].map(relative));
  assert.ok(FORBIDDEN.some((f) => reachable.has(f)), "the import walker is not working");
});

test("the live runner's paper branch runs BEFORE anything is dispatched", () => {
  // A source-order check, because the isolation above cannot see control flow:
  // `fireAlert` reaches the dispatcher on the live path, so what matters is
  // that the paper branch returns first.
  const src = fs.readFileSync(path.join(SRC, "engine", "liveRunner.ts"), "utf8");
  const paperBranch = src.indexOf('if (dep.delivery === "paper")');
  const firstDeliver = src.indexOf("deliver(", paperBranch);
  assert.ok(paperBranch > 0, "the paper branch must exist in fireAlert");
  assert.ok(
    firstDeliver === -1 || paperBranch < firstDeliver,
    "the paper branch must come before any call to deliver()"
  );
  const branchBody = src.slice(paperBranch, src.indexOf("\n    }", paperBranch));
  assert.match(branchBody, /return true;/, "the paper branch must return, not fall through");
  assert.doesNotMatch(branchBody, /deliver\(/, "the paper branch must not deliver");
});

test("a paper deployment never starts an alert as `pending`, because nothing will send it", () => {
  const src = fs.readFileSync(path.join(SRC, "engine", "liveRunner.ts"), "utf8");
  assert.match(src, /deliveryStatus: deliversLiveOrders\(dep\.delivery\) \? "pending" : "skipped"/);
});
