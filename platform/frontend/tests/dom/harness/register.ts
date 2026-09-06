/**
 * The browser this repository did not have.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The frontend suite is 782 assertions and every one of them is a pure
 * function or a regular expression over source text. That layer is genuinely
 * valuable and none of it is being removed — but a whole class of defect is
 * invisible to it, and the previous campaign found several of that class in
 * production: a hook wired to the wrong argument, a menu handler that read the
 * pointer's price instead of the drawing's, a persistence effect that saved an
 * empty list over a restored one, a keyboard listener that fired while the
 * user was typing. Every one of those is correct in every unit it is made of
 * and wrong when the units are connected.
 *
 * So this installs a real DOM — jsdom — as the process globals, once, before
 * any test module is loaded. It is registered with `--import`, not imported
 * from a test file, because React, React DOM and Testing Library all capture
 * `window` and `document` at module-evaluation time: a setup that runs after
 * the first `import` of `react-dom/client` is a setup that runs too late.
 *
 * ── What is faked and what is not ──────────────────────────────────────────
 *
 * Faked: only the four things jsdom genuinely does not implement — a canvas
 * rendering context, `PointerEvent`, `ResizeObserver`, and `matchMedia`. Each
 * is the smallest object the product actually calls into, and each is here
 * rather than in a test so that no single test can quietly widen it.
 *
 * Not faked: the components, the hooks, the stores, the routing helpers and
 * `localStorage`. Those are the things under test. A test that mocks the unit
 * it is testing proves the mock.
 */
import { JSDOM, VirtualConsole } from "jsdom";

/*
 * jsdom implements no navigation, and says so loudly.
 *
 * A page that assigns `window.location.href` — the sign-in form, after a
 * successful sign-in — produces a `jsdomError` that is not a failure and not
 * anything a test can act on. Everything else jsdom reports is forwarded
 * unchanged, because an uncaught exception inside a component arrives that
 * way and must stay visible.
 */
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error: Error) => {
  if (/Not implemented: navigation/.test(error.message)) return;
  console.error(error);
});
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  virtualConsole.on(level, (...args: unknown[]) => {
    (console[level] as (...a: unknown[]) => void)(...args);
  });
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1/chart",
  pretendToBeVisual: true,
  virtualConsole,
});

const win = dom.window as unknown as Window & typeof globalThis;

/*
 * A 2D context that answers, and measures nothing.
 *
 * `lightweight-charts` and `DrawingCanvas` both call `getContext("2d")` and
 * dereference the result immediately; jsdom returns `null` without the native
 * `canvas` package, which turns every chart render into a TypeError. The stub
 * returns plausible zeroes: a test must never assert on a pixel, and this
 * makes that impossible rather than merely discouraged.
 */
const canvasContext = (): unknown => {
  const noop = (): void => {};
  const ctx: Record<string, unknown> = {
    canvas: null,
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    setTransform: noop, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false, isPointInStroke: () => false,
  };
  for (const name of [
    "save", "restore", "scale", "rotate", "translate", "transform", "resetTransform",
    "clearRect", "fillRect", "strokeRect", "beginPath", "closePath", "moveTo", "lineTo",
    "bezierCurveTo", "quadraticCurveTo", "arc", "arcTo", "ellipse", "rect", "roundRect",
    "fill", "stroke", "clip", "fillText", "strokeText", "drawImage", "setLineDash",
    "getLineDash", "createConicGradient", "createRadialGradient",
  ]) ctx[name] = noop;
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop);
      // Style properties (`fillStyle`, `font`, `lineWidth`, …) read back as set.
      return undefined;
    },
    set(target, prop, value) { Reflect.set(target, prop, value); return true; },
  });
};

(win.HTMLCanvasElement.prototype as unknown as {
  getContext: (id: string) => unknown;
}).getContext = function getContext(id: string): unknown {
  return id === "2d" ? canvasContext() : null;
};

/*
 * `PointerEvent`.
 *
 * jsdom has none, and the drawing layer is entirely pointer-driven — which is
 * exactly the surface these tests exist to exercise. Subclassing `MouseEvent`
 * keeps `clientX`/`clientY`/`button` real; only the pointer identity fields
 * are added.
 */
if (typeof win.PointerEvent === "undefined") {
  class PointerEventPolyfill extends win.MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? 0.5;
    }
  }
  (win as unknown as Record<string, unknown>).PointerEvent = PointerEventPolyfill;
}
/* Capture is a no-op here; the tests dispatch to the element directly. */
for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
  if (!(name in win.Element.prototype)) {
    (win.Element.prototype as unknown as Record<string, unknown>)[name] =
      name === "hasPointerCapture" ? (): boolean => false : (): void => {};
  }
}
if (!("scrollIntoView" in win.Element.prototype)) {
  (win.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = (): void => {};
}

/*
 * A layout.
 *
 * jsdom runs no layout engine at all: every element reports a zero-sized box,
 * so `lightweight-charts` builds a chart 0px wide, the drawing layer's
 * "is this point inside the plot?" is false everywhere, and a right-click
 * lands in no region. Reporting one fixed desktop-sized box makes the geometry
 * consistent and lets the real price/time scales do real arithmetic.
 *
 * `giveLayout()` overrides the box for one element, for a test that needs two
 * different sizes on screen at once. Nothing here fakes a MEASUREMENT the
 * product then asserts on — no test in this suite asserts a pixel.
 */
interface Box { width: number; height: number; x?: number; y?: number }

const DEFAULT_BOX: Box = { width: 1280, height: 800 };
const boxes = new WeakMap<object, Box>();

export function giveLayout(el: object, box: Box): void {
  boxes.set(el, box);
}

const boxOf = (el: object): { width: number; height: number; x: number; y: number } => {
  const box = boxes.get(el) ?? DEFAULT_BOX;
  return { width: box.width, height: box.height, x: box.x ?? 0, y: box.y ?? 0 };
};

win.Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
  const b = boxOf(this as object);
  return {
    x: b.x, y: b.y, width: b.width, height: b.height,
    top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height,
    toJSON() { return this; },
  } as DOMRect;
};
for (const [prop, pick] of [
  ["clientWidth", "width"], ["offsetWidth", "width"],
  ["clientHeight", "height"], ["offsetHeight", "height"],
] as const) {
  Object.defineProperty(win.HTMLElement.prototype, prop, {
    configurable: true,
    get(): number { return boxOf(this as object)[pick]; },
  });
}

/** jsdom has neither observer; both are used purely to learn about resizes. */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return []; }
}
for (const name of ["ResizeObserver", "IntersectionObserver"]) {
  if (typeof (win as unknown as Record<string, unknown>)[name] === "undefined") {
    (win as unknown as Record<string, unknown>)[name] = NoopObserver;
  }
}

/** A desktop viewport that never matches a `prefers-*` query. */
if (typeof win.matchMedia === "undefined") {
  (win as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/*
 * A Mac user agent.
 *
 * `isMacPlatform()` reads `navigator.platform`, and the modifier shortcuts —
 * Cmd+Z, Cmd+C — resolve differently on the other branch. The product is
 * developed and used on a Mac, so that is the branch the tests must take by
 * default; the pure table covers the other one.
 */
Object.defineProperty(win.navigator, "platform", { value: "MacIntel", configurable: true });

/*
 * Promote the jsdom window's own properties to process globals.
 *
 * Everything the browser bundle expects to find on `globalThis` — including
 * the constructors `instanceof` checks are written against, which must be the
 * SAME classes the document creates.
 */
const globals = globalThis as unknown as Record<string, unknown>;

/*
 * `defineProperty` rather than assignment.
 *
 * Node 26 installs `globalThis.navigator` as an accessor with no setter, so a
 * plain assignment throws and takes the whole harness with it. Defining the
 * property replaces the accessor outright, which is what is wanted: inside a
 * test the document's own `navigator` is the only correct answer.
 */
const define = (key: string, value: unknown): void => {
  try {
    Object.defineProperty(globals, key, {
      value, writable: true, configurable: true, enumerable: true,
    });
  } catch { /* a non-configurable global stays as it is */ }
};

define("window", win);
define("document", win.document);
define("navigator", win.navigator);
define("location", win.location);
define("history", win.history);
define("localStorage", win.localStorage);
define("sessionStorage", win.sessionStorage);
define("getComputedStyle", win.getComputedStyle.bind(win));
define("requestAnimationFrame", win.requestAnimationFrame.bind(win));
define("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
for (const key of Object.getOwnPropertyNames(win)) {
  if (key in globals) continue;
  if (key.startsWith("_")) continue;
  const value = (win as unknown as Record<string, unknown>)[key];
  if (typeof value === "function" || (value && typeof value === "object")) {
    define(key, value);
  }
}

/** React 18 refuses to batch updates outside an act() environment without this. */
define("IS_REACT_ACT_ENVIRONMENT", true);
