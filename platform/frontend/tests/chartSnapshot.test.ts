/**
 * A picture of the chart.
 *
 * TVP8: the reference has a camera in its top toolbar and this product had
 * nothing — the only way to share a chart was the operating system's screen
 * capture, which takes the browser chrome and the desktop with it.
 *
 * The compositing itself needs a canvas, so it is exercised in the DOM suite
 * through the real pane. What is tested here is everything around it that is
 * pure, plus the wiring — because a camera button that is not connected to a
 * shortcut, or a filename nobody can find again, are the two ways this feature
 * quietly fails to be one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { snapshotFilename } from "../lib/chartSnapshot";
import { BINDINGS } from "../lib/shortcuts";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("a snapshot is named so a person can find it again", () => {
  const at = new Date("2026-09-13T15:40:23.000Z");
  assert.equal(snapshotFilename("BTCUSDT", "4h", at), "BTCUSDT-4h-2026-09-13-15-40.png");

  /*
   * A canonical id, a slash or a colon in the ticker must not reach the
   * filesystem: `instrument:v1:BINANCE:spot:…` as a filename is rejected by
   * Windows outright and is unreadable everywhere else.
   */
  assert.equal(
    snapshotFilename("instrument:v1:BINANCE:spot:BTC:USDT", "1d", at),
    "instrumentv1BINANCEspotBTCUSDT-1d-2026-09-13-15-40.png");
  assert.match(snapshotFilename("", "4h", at), /^chart-4h-/,
    "a nameless symbol still produces a usable filename");
});

test("THE CAMERA IS REACHABLE THREE WAYS, AND ALL OF THEM RUN ONE IMPLEMENTATION", () => {
  const page = code("app/chart/page.tsx");
  const toolbar = code("components/tv/ChartToolbar.tsx");

  // The toolbar button, where the reference puts it.
  assert.match(toolbar, /onClick=\{\(e\) => props\.onSnapshot\(e\.altKey \? "copy" : "save"\)\}/,
    "click saves, Alt-click copies — the pair the reference offers from its camera menu");
  assert.match(page, /onSnapshot=\{snapshot\}/);

  // The keyboard, through the same table every other action uses.
  const save = BINDINGS.find((b) => b.action === "snapshot-save");
  const copy = BINDINGS.find((b) => b.action === "snapshot-copy");
  assert.ok(save && copy, "a camera with no keyboard route is half a feature");
  assert.equal(save!.mod, true);
  assert.equal(save!.shift, true);
  assert.match(page, /case "snapshot-save": void snapshot\("save"\)/);
  assert.match(page, /case "snapshot-copy": void snapshot\("copy"\)/);

  // And one implementation behind all of them.
  assert.equal((page.match(/compositePane\(/g) ?? []).length, 1,
    "two copies of 'capture the chart' is two things to keep in step");
});

test("a capture that cannot happen says why, rather than saving a blank rectangle", () => {
  const page = code("app/chart/page.tsx");
  assert.match(page, /There is no chart to capture yet\./);
  assert.match(page, /The chart has not finished drawing\./);

  /*
   * `copyCanvasToClipboard` throws a SENTENCE. `ClipboardItem` is absent in
   * Firefox and the permission can be refused in any browser, and "copy
   * failed" with no reason is the worst possible answer to a button the user
   * just pressed — so both failures name Save image as the way out.
   */
  const lib = code("lib/chartSnapshot.ts");
  assert.match(lib, /This browser cannot copy an image\. Use Save image instead\./);
  assert.match(lib, /The clipboard refused the image\. Use Save image instead\./);
});

test("the snapshot paints a ground, or a dark chart arrives white", () => {
  /*
   * The chart's layout background is transparent so the pane's surface shows
   * through on screen. A PNG with a transparent ground renders as whatever the
   * viewer's chat client uses, which for a dark chart is usually white — the
   * candles survive and everything around them inverts.
   */
  const lib = code("lib/chartSnapshot.ts");
  assert.match(lib, /ctx\.fillRect\(0, 0, box\.width, box\.height\)/);
  assert.match(lib, /ground && ground !== "rgba\(0, 0, 0, 0\)" \? ground : "#131313"/);

  // Every canvas in the pane, in DOM order: the drawing layer is its own
  // canvas and must land over the candles in the file as it does on screen.
  assert.match(lib, /host\.querySelectorAll\("canvas"\)/);
  assert.match(lib, /for \(const canvas of canvases\)/);

  // One bad layer must not lose the rest.
  assert.match(lib, /catch \{[\s\S]*?\}/);
});
