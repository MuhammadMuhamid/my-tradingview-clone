/**
 * Storage that refuses.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * `localStorage.setItem` throws, and this product calls it forty-one times.
 * Two failures, neither rare: the QUOTA (Safari gives an origin ~5MB and this
 * product spends it on drawings, workspaces, chart settings, watchlists and
 * per-pane studies) and ACCESS — Safari Private Browsing, Firefox with
 * `dom.storage.enabled=false`, a locked-down corporate profile, or Chrome in
 * an iframe with third-party cookies blocked, where the ACCESSOR itself throws
 * before any method is called.
 *
 * TVP8 round two found five writes with no guard at all. An uncaught throw
 * from any of them takes down whatever rendered the control — toggling the
 * bottom panel, switching watchlists, turning autosave off. The thirty-six
 * that were guarded each carried their own comment explaining the same thing,
 * which is how the five happened.
 *
 * So the rule below is about the CLASS: no product code touches `localStorage`
 * unguarded, wherever the next one is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Every product source file — the same scope the contract rules use. */
const PRODUCT = ["app", "components", "lib"].flatMap((d) => walk(d));

test("the storage module survives a browser that refuses to store", async () => {
  /*
   * Imported fresh per case: the module must not cache the accessor, because
   * Chrome's storage permission can be granted or revoked while the page is
   * open and a cache would hold the answer from before.
   */
  const load = async () => {
    const url = new URL(`../lib/browserStorage.ts?case=${Math.random()}`, `file://${__filename}`);
    return (await import(url.href)) as typeof import("../lib/browserStorage");
  };

  const install = (impl: unknown): void => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { get localStorage() { 
        if (impl === "throws") throw new DOMException("The operation is insecure.", "SecurityError");
        return impl;
      }, get sessionStorage() { return impl === "throws" ? (() => { throw new Error("no"); })() : impl; } },
    });
  };

  // 1. The accessor throws — Safari Private Browsing, a locked profile.
  install("throws");
  {
    const s = await load();
    assert.equal(s.canRemember(), false);
    assert.equal(s.remember("k", "v"), false, "a refusal is a return value, not a throw");
    assert.equal(s.recall("k", "fallback"), "fallback");
    assert.equal(s.recallJson("k", { safe: true }).safe, true);
    s.forget("k"); // must not throw
  }

  // 2. The accessor works but `setItem` throws — the quota.
  const written = new Map<string, string>();
  install({
    setItem() { throw new DOMException("exceeded the quota.", "QuotaExceededError"); },
    getItem: (k: string) => written.get(k) ?? null,
    removeItem: (k: string) => { written.delete(k); },
  });
  {
    const s = await load();
    assert.equal(s.canRemember(), true, "storage EXISTS — it is simply full");
    assert.equal(s.remember("k", "v"), false);
    assert.equal(s.rememberJson("k", { a: 1 }), false);
  }

  // 3. A working browser stores and reads back.
  install({
    setItem: (k: string, v: string) => { written.set(k, v); },
    getItem: (k: string) => written.get(k) ?? null,
    removeItem: (k: string) => { written.delete(k); },
  });
  {
    const s = await load();
    assert.equal(s.remember("k", "v"), true);
    assert.equal(s.recall("k"), "v");
    assert.equal(s.rememberJson("j", { a: 1 }), true);
    assert.deepEqual(s.recallJson("j", { a: 0 }), { a: 1 });
    s.forget("k");
    assert.equal(s.recall("k", "gone"), "gone");
  }

  // 4. A record this build cannot parse degrades to a first visit, not a throw.
  written.set("bad", "{not json");
  {
    const s = await load();
    assert.deepEqual(s.recallJson("bad", { first: true }), { first: true },
      "storage outlives the code that wrote it");
  }

  // 5. A value that cannot be serialised is simply not stored.
  {
    const s = await load();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(s.rememberJson("circular", circular), false);
  }

  Reflect.deleteProperty(globalThis, "window");
});

test("NO PRODUCT CODE TOUCHES STORAGE UNGUARDED", () => {
  /*
   * The class, not the five instances that were found.
   *
   * A write is guarded if it is inside a `try` block or goes through
   * `lib/browserStorage`. Counting braces is enough here and deliberately
   * crude: the failure mode of a crude parser is a FALSE POSITIVE, which costs
   * somebody a minute, where the failure mode of a clever one is silence.
   */
  const offenders: string[] = [];
  for (const file of PRODUCT) {
    if (file === path.join("lib", "browserStorage.ts")) continue;
    const src = code(read(file));
    const lines = src.split("\n");

    // Depth of open `try {` blocks at the start of each line.
    let depth = 0;
    const tryStack: number[] = [];
    lines.forEach((line, i) => {
      const inTry = tryStack.length > 0;
      for (const ch of line) {
        if (ch === "{") { depth++; }
        else if (ch === "}") {
          depth--;
          while (tryStack.length && tryStack[tryStack.length - 1]! > depth) tryStack.pop();
        }
      }
      if (/\btry\s*\{/.test(line)) tryStack.push(depth - 1);

      if (/\b(?:local|session)Storage\s*\.\s*(?:setItem|getItem|removeItem|clear|key)\s*\(/.test(line)
          && !inTry && !/\btry\s*\{/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 88)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "these throw in a private window, on a locked profile, and when the quota is "
    + "full — route them through lib/browserStorage:\n  " + offenders.join("\n  "));
});

test("THE RULE ABOVE IS ACTUALLY READING THE PRODUCT", () => {
  /*
   * The tripwire every source-text rule in this suite needs. A regex that
   * stops matching reports zero offenders, which is indistinguishable from a
   * clean product — and this one is a whole-tree walk, so a broken `walk` or a
   * renamed directory would silently empty it.
   */
  assert.ok(PRODUCT.length > 200, `walked only ${PRODUCT.length} product files`);
  const touching = PRODUCT.filter((f) =>
    /\b(?:local|session)Storage\s*\./.test(code(read(f))));
  assert.ok(touching.length > 10,
    `found storage in only ${touching.length} files — this rule has stopped reading`);
});
