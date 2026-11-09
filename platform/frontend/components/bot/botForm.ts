/**
 * The bot form's model: every field the Classic dashboard's form has, its
 * defaults, the validation the Bot applies (so a refusal is explained before
 * anything is sent), the payload, and what an edit changes.
 *
 * Adapted from the standalone Bot dashboard (bot/frontend/src/lib/botForm.ts:
 * `PAIRS`, `defaultBotForm`, `unsafeConfigReason`, `buildBotPayload`), with the
 * stale parts fixed (parity inventory §5):
 *   #2 the 50 % unprotected-size rule is CALLED, not only exported;
 *   #5 limit entries are not selectable (stored but never executed);
 *   #6 the investment amount is bounded per unit (≤ 100 for a percentage);
 *   #7 pairs must be a USDT/USDC Spot symbol;
 *   #8 an empty or junk number is an error, never a silent 0;
 *   #9 the name is trimmed and 1-64 characters.
 * The Bot's rules (bot `services/botAdmin.ts`) stay authoritative.
 */
import type { BotConfigView, InvestmentUnit } from "@/lib/botManageApi";

export const PAIRS = [
  "BTCUSDT", "ETHUSDT", "APTUSDT", "NEARUSDT", "TIAUSDT", "SOLUSDT",
  "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT",
];

export const INVESTMENT_UNIT_LABELS: Record<InvestmentUnit, string> = {
  pct_bot: "% of total USDT balance, per bot",
  pct_trade: "% of total USDT balance, per trade",
  usdt_bot: "USDT per bot",
  usdt_trade: "USDT per trade",
};

export const BOT_NAME_MAX = 64;
export const PAIR_RE = /^[A-Z0-9]{2,20}(USDT|USDC)$/;
export const MAX_PAIRS = 50;
export const MAX_PCT_INVESTMENT = 100;
/** The Bot's own bound for every investment unit (`botAdmin.ts`, `.max(10000)`); final review R1. */
export const MAX_USDT_INVESTMENT = 10_000;
/** Mirrors the Bot: a position this large needs a stop loss. */
export const UNPROTECTED_SIZE_LIMIT_PCT = 50;

/** Numbers are kept as the text typed, so an empty field is "empty", not 0. */
export interface BotFormState {
  name: string;
  alertType: "custom" | "tradingview";
  pairs: string[];
  maxInvestmentPct: string;
  maxInvestmentUnit: InvestmentUnit;
  maxActiveSmartTradesEnabled: boolean;
  maxActiveSmartTrades: string;
  exchangeAccountId: string;
  entryEnabled: boolean;
  entryVolumePct: string;
  /** "limit" only when an existing bot already has it; never offered. */
  entryOrderType: "market" | "limit";
  exitEnabled: boolean;
  takeProfitEnabled: boolean;
  takeProfitPct: string;
  stopLossEnabled: boolean;
  stopLossPct: string;
  /** Blank = no limit. */
  maxEntryOrders: string;
}

/** The defaults a NEW bot starts with (BOT-003/BOT-015: 5 %, exits on, a 3 % stop loss). */
export const defaultBotForm: BotFormState = {
  name: "Binance Spot Signal Bot",
  alertType: "custom",
  pairs: [],
  maxInvestmentPct: "5",
  maxInvestmentUnit: "pct_bot",
  maxActiveSmartTradesEnabled: false,
  maxActiveSmartTrades: "2",
  exchangeAccountId: "",
  entryEnabled: true,
  entryVolumePct: "100",
  entryOrderType: "market",
  exitEnabled: true,
  takeProfitEnabled: false,
  takeProfitPct: "5",
  stopLossEnabled: true,
  stopLossPct: "3",
  maxEntryOrders: "",
};

const isPct = (unit: string) => unit === "pct_bot" || unit === "pct_trade";

/** The form for an existing bot (C11's view). */
export function formFromBot(bot: BotConfigView): BotFormState {
  const unit = (["pct_bot", "pct_trade", "usdt_bot", "usdt_trade"].includes(bot.maxInvestmentUnit)
    ? bot.maxInvestmentUnit : "pct_bot") as InvestmentUnit;
  return {
    name: bot.name,
    alertType: bot.alertType === "tradingview" ? "tradingview" : "custom",
    pairs: [...bot.pairs],
    maxInvestmentPct: String(bot.maxInvestmentPct),
    maxInvestmentUnit: unit,
    maxActiveSmartTradesEnabled: bot.maxActiveSmartTradesEnabled,
    maxActiveSmartTrades: String(bot.maxActiveSmartTrades ?? 2),
    exchangeAccountId: bot.exchangeAccountId ?? "",
    entryEnabled: bot.entryEnabled,
    entryVolumePct: String(bot.entryVolumePct),
    entryOrderType: bot.entryOrderType === "limit" ? "limit" : "market",
    exitEnabled: bot.exitEnabled,
    takeProfitEnabled: bot.takeProfitPct !== null,
    takeProfitPct: String(bot.takeProfitPct ?? 5),
    stopLossEnabled: bot.stopLossPct !== null,
    stopLossPct: String(bot.stopLossPct ?? 3),
    maxEntryOrders: bot.maxEntryOrders === null ? "" : String(bot.maxEntryOrders),
  };
}

/** A number typed into a field, or null when it is empty or not a number. */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The stored spelling of a pair the user typed: upper case, no separator. */
export const normalizePair = (raw: string) => raw.trim().toUpperCase().replace(/\//g, "");

export type FormErrors = Partial<Record<keyof BotFormState | "form", string>>;

/**
 * Every refusal the Bot would give for this form, field by field, plus the
 * cross-field safety rule under `form`. `kept` lists pairs the bot already
 * has: the Bot does not re-judge them, so neither does this.
 */
export function validateBotForm(form: BotFormState, kept: string[] = []): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (name.length < 1 || name.length > BOT_NAME_MAX) errors.name = `A name of 1 to ${BOT_NAME_MAX} characters is required.`;
  if (form.pairs.length < 1) errors.pairs = "Select at least one trading pair.";
  else if (form.pairs.length > Math.max(MAX_PAIRS, kept.length)) errors.pairs = `At most ${MAX_PAIRS} pairs per bot.`;
  else if (form.pairs.some((p) => !kept.includes(p) && !PAIR_RE.test(p))) {
    errors.pairs = "Each pair must be a Binance Spot symbol quoted in USDT or USDC, e.g. BTCUSDT.";
  }
  const amount = parseNumber(form.maxInvestmentPct);
  const max = isPct(form.maxInvestmentUnit) ? MAX_PCT_INVESTMENT : MAX_USDT_INVESTMENT;
  if (amount === null || amount < 0.01 || amount > max) {
    errors.maxInvestmentPct = isPct(form.maxInvestmentUnit)
      ? `Enter a percentage from 0.01 to ${MAX_PCT_INVESTMENT}.` : `Enter an amount from 0.01 to ${MAX_USDT_INVESTMENT.toLocaleString()} USDT.`;
  }
  if (form.maxActiveSmartTradesEnabled) {
    const cap = parseNumber(form.maxActiveSmartTrades);
    if (cap === null || !Number.isInteger(cap) || cap < 1) errors.maxActiveSmartTrades = "Enter a whole number of 1 or more.";
  }
  const volume = parseNumber(form.entryVolumePct);
  if (volume === null || volume < 1 || volume > 100) errors.entryVolumePct = "Enter a percentage from 1 to 100.";
  if (form.takeProfitEnabled) {
    const tp = parseNumber(form.takeProfitPct);
    if (tp === null || tp <= 0 || tp > 1000) errors.takeProfitPct = "Enter a take profit above 0 and at most 1000%.";
  }
  if (form.stopLossEnabled) {
    const sl = parseNumber(form.stopLossPct);
    if (sl === null || sl <= 0 || sl > 100) errors.stopLossPct = "Enter a stop loss above 0 and at most 100%.";
  }
  if (form.maxEntryOrders.trim() !== "") {
    const n = parseNumber(form.maxEntryOrders);
    if (n === null || !Number.isInteger(n) || n < 1) errors.maxEntryOrders = "Enter a whole number of 1 or more, or leave it empty.";
  }
  const unsafe = unsafeConfigReason(form);
  if (unsafe) errors.form = unsafe;
  return errors;
}

/** The Bot's cross-field rule, incl. the 50 % unprotected-size rule. Wired into the form (§5 #2). */
export function unsafeConfigReason(form: BotFormState): string | null {
  const amount = parseNumber(form.maxInvestmentPct) ?? 0;
  const volume = parseNumber(form.entryVolumePct) ?? 0;
  if (isPct(form.maxInvestmentUnit) && (amount * volume) / 100 >= UNPROTECTED_SIZE_LIMIT_PCT && !form.stopLossEnabled) {
    return `A position of ${UNPROTECTED_SIZE_LIMIT_PCT}% of the balance or more requires a stop loss. `
      + "Turn the stop loss on, or reduce the investment or the entry volume.";
  }
  return null;
}

/** What a create sends: every field, with the switched-off distances as null. */
export function buildBotPayload(form: BotFormState): Record<string, unknown> {
  return {
    name: form.name.trim(),
    alertType: form.alertType,
    direction: "long",
    pairs: form.pairs,
    maxInvestmentPct: parseNumber(form.maxInvestmentPct),
    maxInvestmentUnit: form.maxInvestmentUnit,
    exchangeAccountId: form.exchangeAccountId || null,
    entryEnabled: form.entryEnabled,
    entryVolumePct: parseNumber(form.entryVolumePct),
    entryOrderType: form.entryOrderType,
    exitEnabled: form.exitEnabled,
    takeProfitEnabled: form.takeProfitEnabled,
    takeProfitPct: form.takeProfitEnabled ? parseNumber(form.takeProfitPct) : null,
    stopLossEnabled: form.stopLossEnabled,
    stopLossPct: form.stopLossEnabled ? parseNumber(form.stopLossPct) : null,
    maxEntryOrders: form.maxEntryOrders.trim() === "" ? null : parseNumber(form.maxEntryOrders),
    maxActiveSmartTradesEnabled: form.maxActiveSmartTradesEnabled,
    maxActiveSmartTrades: form.maxActiveSmartTradesEnabled ? parseNumber(form.maxActiveSmartTrades) : null,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields the operator actually changed, for the "Changed:" summary. The
 * payload (`changedFields`) also re-sends a changed field's partner (an
 * amount travels with its unit), which must not be reported as a change.
 */
export function changedFieldNames(before: BotFormState, after: BotFormState): string[] {
  const a = buildBotPayload(before);
  const b = buildBotPayload(after);
  return Object.keys(b).filter((key) => key !== "direction" && !same(a[key], b[key]));
}

/**
 * What an edit sends: only the fields that changed. A switch and its value
 * travel together, so the Bot judges the pair as one.
 */
export function changedFields(before: BotFormState, after: BotFormState): Record<string, unknown> {
  const a = buildBotPayload(before);
  const b = buildBotPayload(after);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(b)) if (!same(a[key], b[key])) out[key] = b[key];
  const together: [string, string][] = [["takeProfitEnabled", "takeProfitPct"], ["stopLossEnabled", "stopLossPct"],
    ["maxActiveSmartTradesEnabled", "maxActiveSmartTrades"], ["maxInvestmentPct", "maxInvestmentUnit"]];
  for (const [x, y] of together) {
    if (x in out || y in out) { out[x] = b[x]; out[y] = b[y]; }
  }
  // An unchanged legacy "limit" is never re-sent; direction is not editable.
  delete out.direction;
  return out;
}

/**
 * Whether an edit loosens protection, so the Platform asks for a fresh code
 * (backend `weakensProtection`, B-SLICE2): stop loss off or further away,
 * investment up or its unit changed, entry volume up, a cap removed or
 * raised, another account, entries on, exits off.
 */
export function weakensProtection(changed: Record<string, unknown>, bot: BotConfigView): boolean {
  const has = (k: string) => changed[k] !== undefined;
  if (bot.stopLossPct !== null) {
    if (changed.stopLossEnabled === false) return true;
    if (typeof changed.stopLossPct === "number" && changed.stopLossPct > bot.stopLossPct) return true;
  }
  if (has("maxInvestmentUnit") && changed.maxInvestmentUnit !== bot.maxInvestmentUnit) return true;
  if (typeof changed.maxInvestmentPct === "number" && changed.maxInvestmentPct > bot.maxInvestmentPct) return true;
  if (typeof changed.entryVolumePct === "number" && changed.entryVolumePct > bot.entryVolumePct) return true;
  if (bot.maxActiveSmartTradesEnabled) {
    if (changed.maxActiveSmartTradesEnabled === false) return true;
    if (typeof changed.maxActiveSmartTrades === "number" && bot.maxActiveSmartTrades !== null
      && changed.maxActiveSmartTrades > bot.maxActiveSmartTrades) return true;
  }
  if (bot.maxEntryOrders !== null && has("maxEntryOrders")
    && (changed.maxEntryOrders === null || (changed.maxEntryOrders as number) > bot.maxEntryOrders)) return true;
  if (has("exchangeAccountId") && changed.exchangeAccountId !== bot.exchangeAccountId) return true;
  if (changed.entryEnabled === true && !bot.entryEnabled) return true;
  if (changed.exitEnabled === false && bot.exitEnabled) return true;
  return false;
}

/** "≈ 42.50 USDT of 850.00 available", for a percentage unit when the free balance is known. */
export function investmentEstimate(form: BotFormState, usdtFree: number | null): string | null {
  const amount = parseNumber(form.maxInvestmentPct);
  if (usdtFree === null || amount === null || !isPct(form.maxInvestmentUnit)) return null;
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `≈ ${fmt((usdtFree * amount) / 100)} USDT of ${fmt(usdtFree)} available`;
}
