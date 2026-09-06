/**
 * Which resolutions the workspace offers, and which are one click away.
 *
 * ── Why this is data rather than a literal in the toolbar ───────────────────
 *
 * The toolbar hard-coded six intervals and the pane header hard-coded the same
 * six again, so the five the backend already served — 3m, 30m, 2h, 6h, 12h —
 * were reachable only by editing persisted state by hand. That is not a design
 * decision; it is a list that fell out of date twice.
 *
 * Since then the chart gained resolutions the candle store does not hold at
 * all: `30s` folded from thirty one-second bars, `45m` from three fifteens.
 * `lib/resolution` decides which of those are arithmetically honest. This file
 * decides which of the honest ones a person sees first, and where.
 *
 * ── The shape, taken from the benchmark ────────────────────────────────────
 *
 * TradingView's own interval control, observed live and cached under
 * `evidence/P1A_tv/`, is ONE button showing the current interval, opening a
 * grouped picker (Seconds / Minutes / Hours / Days) whose rows each carry a
 * hover-revealed "Add to favorites" star, with "Add custom interval…" at the
 * top. Favourited intervals appear as quick buttons beside the button. That is
 * how a thirty-entry catalogue stays off a one-row toolbar, and it is the
 * grammar adopted here.
 *
 * The default favourites are the six the toolbar always showed, deliberately:
 * the point of this module is to stop hiding everything else, not to
 * relitigate which timeframes a scalper reaches for.
 *
 * ── Everything here is pure ────────────────────────────────────────────────
 *
 * Favourites, recents and custom entries are lists, and every operation on
 * them is a function from a list to a list. The component reads and writes
 * `localStorage`; it does not decide what a valid list is. That is what lets
 * `tests/timeframes.test.ts` assert the rules without a browser.
 */
import { parseResolution, type Resolution } from "./resolution";
import { ALERT_INTERVAL_VALUES, type Interval } from "./types";

export interface ResolutionGroup {
  label: string;
  items: readonly Resolution[];
}

/**
 * The offered catalogue.
 *
 * Every entry is either a resolution the venue publishes or an exact multiple
 * of one — `parseResolution` returns non-null for all of them, and
 * `tests/timeframes.test.ts` asserts exactly that rather than trusting the list
 * to have been typed correctly.
 *
 * The seconds are TradingView's own set minus `45s`, plus `1s`, which Binance
 * publishes directly. The minutes and hours add `10m`, `45m` and `3h`, each a
 * whole multiple of a stored interval. Nothing longer than a day is offered:
 * see `lib/resolution` for why a week is not arithmetic.
 */
export const RESOLUTION_CATALOGUE: readonly ResolutionGroup[] = [
  { label: "Seconds", items: ["1s", "5s", "10s", "15s", "30s"] },
  { label: "Minutes", items: ["1m", "3m", "5m", "10m", "15m", "30m", "45m"] },
  { label: "Hours", items: ["1h", "2h", "3h", "4h", "6h", "8h", "12h"] },
  { label: "Days", items: ["1d"] },
];

/** Every catalogued resolution, flat, in catalogue order. */
export const CATALOGUE_RESOLUTIONS: readonly Resolution[] =
  RESOLUTION_CATALOGUE.flatMap((group) => group.items);

/** The six the toolbar has always shown, and still shows to a new user. */
export const DEFAULT_FAVOURITES: readonly Resolution[] =
  ["1m", "5m", "15m", "1h", "4h", "1d"];

export const FAVOURITES_KEY = "tv.resolution.favourites.v1";
export const RECENTS_KEY = "tv.resolution.recents.v1";
export const CUSTOM_KEY = "tv.resolution.custom.v1";

/**
 * How many favourites may sit on the toolbar.
 *
 * A cap rather than a scroll: the strip is the row's compressible element, and
 * a person who has starred twenty resolutions has turned the primary row back
 * into the ragged three-row bar this workspace spent a phase removing. Eight is
 * two more than the historical six and still fits beside the symbol control at
 * a laptop width.
 */
export const MAX_FAVOURITES = 8;

/** Recently used resolutions, newest first. Enough to get back, not a history. */
export const MAX_RECENTS = 6;

/** How many custom resolutions one browser keeps. */
export const MAX_CUSTOM = 12;

/** Only resolutions, only once, order preserved. */
function clean(list: readonly unknown[], max: number): Resolution[] {
  const out: Resolution[] = [];
  for (const raw of list) {
    const plan = parseResolution(raw);
    if (plan === null || out.includes(plan.id)) continue;
    out.push(plan.id);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Read a stored list, discarding anything that is no longer a resolution.
 *
 * A stored `"7s"` from a hand-edited entry, or a `"1w"` from a build that once
 * offered weeks, is dropped rather than handed to the chart. A list that
 * becomes empty falls back to `fallback`, so a corrupted favourites entry gives
 * a new user's toolbar rather than a blank one.
 */
export function parseStoredResolutions(
  raw: unknown, max: number, fallback: readonly Resolution[] = []
): Resolution[] {
  if (!Array.isArray(raw)) return [...fallback];
  const list = clean(raw, max);
  return list.length > 0 ? list : [...fallback];
}

/** Star or unstar, capped. Unstarring the last favourite is allowed. */
export function toggleFavourite(
  favourites: readonly Resolution[], resolution: Resolution
): Resolution[] {
  const plan = parseResolution(resolution);
  if (plan === null) return [...favourites];
  if (favourites.includes(plan.id)) return favourites.filter((f) => f !== plan.id);
  if (favourites.length >= MAX_FAVOURITES) return [...favourites];
  /*
   * Inserted in catalogue order rather than appended.
   *
   * A strip that reorders itself as you star things is a strip whose buttons
   * are in a different place every session; muscle memory is most of what a
   * timeframe strip is for. Anything not in the catalogue — a custom
   * resolution — goes to the end, which is stable for the same reason.
   */
  const next = [...favourites, plan.id];
  const rank = (r: Resolution): number => {
    const index = CATALOGUE_RESOLUTIONS.indexOf(r);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return next.sort((a, b) => rank(a) - rank(b));
}

export function isFavourite(
  favourites: readonly Resolution[], resolution: Resolution
): boolean {
  return favourites.includes(resolution);
}

/** Most recent first, no repeats, capped. A favourite is not a recent. */
export function recordRecent(
  recents: readonly Resolution[], resolution: Resolution,
  favourites: readonly Resolution[] = []
): Resolution[] {
  const plan = parseResolution(resolution);
  if (plan === null || favourites.includes(plan.id)) return [...recents];
  return [plan.id, ...recents.filter((r) => r !== plan.id)].slice(0, MAX_RECENTS);
}

/** Add a custom resolution, newest first. Already-catalogued ones are not custom. */
export function addCustom(
  custom: readonly Resolution[], resolution: Resolution
): Resolution[] {
  const plan = parseResolution(resolution);
  if (plan === null || CATALOGUE_RESOLUTIONS.includes(plan.id)) return [...custom];
  return [plan.id, ...custom.filter((r) => r !== plan.id)].slice(0, MAX_CUSTOM);
}

export function removeCustom(
  custom: readonly Resolution[], resolution: Resolution
): Resolution[] {
  return custom.filter((r) => r !== resolution);
}

/** The unit a custom entry may be written in. */
export type CustomUnit = "s" | "m" | "h";

export const CUSTOM_UNITS: readonly { value: CustomUnit; label: string }[] = [
  { value: "s", label: "seconds" },
  { value: "m", label: "minutes" },
  { value: "h", label: "hours" },
];

/**
 * Turn "45" + "minutes" into a resolution, or explain why it is not one.
 *
 * Returns a reason rather than null-and-nothing because every refusal here has
 * a specific cause a person can act on: a number that is not a number, one that
 * is out of range, or one whose canonical spelling is a different unit (`60`
 * minutes is `1h`, and offering two names for one resolution would split the
 * history cache and the persisted pane state between them).
 */
export function parseCustomEntry(
  count: string, unit: CustomUnit
): { resolution: Resolution } | { error: string } {
  const text = count.trim();
  if (!/^[0-9]{1,6}$/.test(text)) return { error: "Enter a whole number" };
  const n = Number(text);
  if (n <= 0) return { error: "Enter a number greater than zero" };
  const plan = parseResolution(`${n}${unit}`);
  if (plan !== null) return { resolution: plan.id };
  const canonical = parseResolution(
    // Re-ask in the unit the value canonically belongs to, so the message can
    // name it: 60 minutes is refused, and saying "that is 1h" is the whole of
    // what the person needs to know.
    unit === "s" && n % 60 === 0 ? `${n / 60}m`
      : unit === "m" && n % 60 === 0 ? `${n / 60}h`
        : unit === "h" && n % 24 === 0 ? `${n / 24}d`
          : `${n}${unit}`
  );
  if (canonical !== null) return { error: `That is ${canonical.id} — use that instead` };
  return { error: "Too long: a day is the longest resolution this chart folds" };
}

export interface TimeframeStrip {
  /** Rendered as individual buttons on the toolbar. */
  quick: readonly Resolution[];
  /** True when the current resolution is one of them. */
  currentInQuick: boolean;
  /**
   * What the picker button says.
   *
   * The current resolution when the strip does not already show it, so a strip
   * with nothing pressed never reads as "no timeframe". Otherwise a plain
   * label, because repeating a pressed button beside itself is noise.
   */
  menuLabel: string;
}

export function timeframeStrip(
  current: Resolution, favourites: readonly Resolution[] = DEFAULT_FAVOURITES
): TimeframeStrip {
  const quick = favourites.slice(0, MAX_FAVOURITES);
  const currentInQuick = quick.includes(current);
  return {
    quick,
    currentInQuick,
    menuLabel: currentInQuick ? "Timeframe" : current,
  };
}

/*
 * ── Where a chart resolution stops and a stored interval starts ────────────
 *
 * Alerts, backtests, deployments and the optimizer all run on the candle store
 * — see `types.INTERVAL_VALUES`. A chart may be on a resolution none of them
 * can run on, and the honest thing to do about that is to say so at the
 * control, not to quietly substitute a neighbouring interval and label it with
 * the one the user was looking at. An alert titled 45m that actually fires on
 * 1h bars is worse than an alert that could not be armed.
 */

/**
 * The chart's resolution as a STORED interval, or null when it is derived.
 *
 * What the backtester, the optimizer and a deployment need: a series that
 * exists in the candle store, because that is what they read.
 */
export function storedIntervalFor(resolution: Resolution): Interval | null {
  const plan = parseResolution(resolution);
  return plan !== null && plan.native ? plan.id as Interval : null;
}

/** The chart's resolution as an alert timeframe, or null when it is not one. */
export function alertIntervalFor(resolution: Resolution): Interval | null {
  return (ALERT_INTERVAL_VALUES as readonly string[]).includes(resolution)
    ? resolution as Interval
    : null;
}

/**
 * Why a stored-series subsystem cannot act on this chart, in one sentence.
 *
 * Null when it can. The two reasons are genuinely different and a person can
 * act on both: a derived resolution has no stored series at all, and `1s` has
 * one that this particular subsystem will not run on.
 */
export function nativeOnlyNotice(
  resolution: Resolution, subsystem: string
): string | null {
  const plan = parseResolution(resolution);
  if (plan === null) return `${resolution} is not a resolution this chart can show`;
  if (!plan.native) {
    return `${plan.id} is folded from ${plan.factor} ${plan.source} bars, and ` +
      `${subsystem} runs on stored bars — pick ${plan.source} or another stored ` +
      `timeframe`;
  }
  if (alertIntervalFor(plan.id) === null) {
    return `${subsystem} cannot run on ${plan.id} bars`;
  }
  return null;
}

/**
 * The stored interval a subsystem would fall back to, named out loud.
 *
 * A derived resolution's source; a native one is its own answer. Callers use
 * this to PRESELECT a control the user can then see and change — never to
 * substitute silently, which is why it is always shown beside
 * `nativeOnlyNotice`.
 */
export function storedFallbackFor(resolution: Resolution): Interval | null {
  const plan = parseResolution(resolution);
  if (plan === null) return null;
  const source = plan.native ? plan.id : plan.source;
  return alertIntervalFor(source) ?? storedIntervalFor(source);
}
