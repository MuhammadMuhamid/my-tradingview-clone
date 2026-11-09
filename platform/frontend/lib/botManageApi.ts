/**
 * Bot management from Trading Scene: bots, exchange accounts, enrollment
 * links, linking a deployment, and pausing new entries
 * (backend `api/routes/botManage.ts` and `botControl.ts` C9).
 *
 * Commands use `botControlSend` (same truth rules as every Bot command: a
 * 202 is uncertain, a coded refusal is definitive, a network failure is
 * uncertain). Reads keep the refusal CODE, because the page words it
 * (`bot_not_found`, `exchange_unavailable`, `enrollment_not_found`).
 * Nothing here ever receives a webhook secret; an enrollment link is used
 * once, for `window.location.assign`, and never stored.
 */
import { botControlSend, type BotCommandAnswer, type BotCredential } from "@/lib/api";
import { loadSession, redirectToSignIn } from "@/lib/session";

export type InvestmentUnit = "pct_bot" | "pct_trade" | "usdt_bot" | "usdt_trade";

/** The Bot's `BotConfigView` (contract v2.0, C11). The secret is only ever masked. */
export interface BotConfigView {
  id: string; name: string; status: string; alertType: string; direction: string; pairs: string[];
  maxInvestmentPct: number; maxInvestmentUnit: InvestmentUnit | string; maxInvestmentLabel: string;
  entryEnabled: boolean; entryVolumePct: number; entryOrderType: string; exitEnabled: boolean;
  takeProfitPct: number | null; stopLossPct: number | null; maxEntryOrders: number | null;
  maxActiveSmartTradesEnabled: boolean; maxActiveSmartTrades: number | null;
  exchangeAccountId: string | null; exchangeAccount: { id: string; name: string; testnet: boolean } | null;
  webhookSecretMasked: string; webhookPath: string; activeTrades: number; unresolvedIntents: number;
  createdAt: string; updatedAt: string;
}

export interface LinkedDeployment { id: string; symbol: string; timeframe: string; status: string; delivery: string }
export interface BotDetail {
  bot: BotConfigView;
  platform: { secret: { stored: boolean; updatedAt: string | null }; linkedDeployments: LinkedDeployment[] };
}

export interface ExchangeAccountView {
  id: string; name: string; exchange: string; marketType: string; testnet: boolean; createdAt: string;
  keyHint: string | null; botsUsing: number; openTrades: number;
}

export interface AccountBalance {
  usdtFree: number; totalUsdt: number; breakdown: { asset: string; free: number; locked: number; usdt: number }[];
  cachedAt: string;
}

export interface EnrollmentStatus {
  status: "issued" | "opened" | "completed" | "expired" | "failed";
  purpose: "create" | "replace" | "reveal_webhook" | string;
  accountId?: string; keyHint?: string; outcome?: string;
}

/** A create's or rotation's result, as the Platform answers it (the secret is never in it). */
export interface SecretResult {
  bot: BotConfigView;
  secretIssued: true;
  platformSecret: { secretCaptured: boolean; linkedDeploymentsUpdated: number; secretStoreFailed?: boolean; replayed?: boolean };
}

export type ManageRead<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function read<T>(path: string): Promise<ManageRead<T>> {
  if (typeof window !== "undefined") {
    const session = await loadSession();
    if (session.authEnabled && session.user?.role === "user") {
      return { ok: false, status: 403, code: "admin_only", message: "This part of the platform is available to the administrator only." };
    }
  }
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store" });
  } catch {
    return { ok: false, status: 0, code: "network", message: "The Platform could not be reached." };
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  if (res.ok && isObject(body)) return { ok: true, data: body as T };
  if (res.status === 401) redirectToSignIn(path);
  const payload = isObject(body) ? body : {};
  return { ok: false, status: res.status, code: typeof payload.code === "string" ? payload.code : `http_${res.status}`,
    message: typeof payload.error === "string" ? payload.error : `${res.status}` };
}

const B = "/api/bot/manage";
const id = (value: string) => encodeURIComponent(value);

/** The bot fields a create or edit sends (only the changed ones on an edit). */
export type BotFieldsPayload = Record<string, unknown>;

export const botManageApi = {
  // ── reads ────────────────────────────────────────────────────────────────
  bot: (botId: string) => read<BotDetail>(`${B}/bots/${id(botId)}`),
  accounts: () => read<{ accounts: ExchangeAccountView[] }>(`${B}/accounts`),
  balance: (accountId: string) => read<AccountBalance>(`${B}/accounts/${id(accountId)}/balance`),
  enrollment: (enrollmentId: string) => read<EnrollmentStatus>(`${B}/enrollments/${id(enrollmentId)}`),

  // ── commands ─────────────────────────────────────────────────────────────
  createBot: (requestId: string, fields: BotFieldsPayload, credential: BotCredential) =>
    botControlSend("POST", `${B}/bots`, { requestId, ...fields, credential }),
  updateBot: (requestId: string, botId: string, fields: BotFieldsPayload, credential: BotCredential) =>
    botControlSend("PATCH", `${B}/bots/${id(botId)}`, { requestId, ...fields, credential }),
  deleteBot: (requestId: string, botId: string, credential: BotCredential) =>
    botControlSend("POST", `${B}/bots/${id(botId)}/delete`, { requestId, credential }),
  rotateSecret: (requestId: string, botId: string, credential: BotCredential) =>
    botControlSend("POST", `${B}/bots/${id(botId)}/rotate-secret`, { requestId, credential }),
  deleteAccount: (requestId: string, accountId: string, credential: BotCredential) =>
    botControlSend("POST", `${B}/accounts/${id(accountId)}/delete`, { requestId, confirmation: "REMOVE_ACCOUNT", credential }),
  mintEnrollment: (requestId: string, input: { purpose: "create"; name: string; testnet: boolean; mainnetConfirmation?: "MAINNET" }
    | { purpose: "replace"; accountId: string; mainnetConfirmation?: "MAINNET" }
    | { purpose: "reveal_webhook"; botId: string }, credential: BotCredential) =>
    botControlSend("POST", `${B}/enrollments`, { requestId, ...input, credential }),

  /** Copy the bot's stored secret into a deployment, server-side (grant tier). */
  linkBot: (requestId: string, deploymentId: string, botId: string, credential: BotCredential) =>
    sendPlain(`/api/deployments/${id(deploymentId)}/link-bot`, { requestId, botId, credential }),

  /** Pause or resume new entries: the Platform half and the Bot half (OD-3). */
  setEntries: (requestId: string, input: { paused: true; reason: string; cancelWorkingEntries: boolean } | { paused: false },
    credential: BotCredential) => sendEntries({ requestId, ...input, credential }),
};

/** A Platform-only command (link-bot): 200 is done, a coded 4xx/5xx is a refusal, anything else unknown. */
async function sendPlain(path: string, body: Record<string, unknown> & { requestId: string }): Promise<BotCommandAnswer> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  } catch {
    return { kind: "uncertain", requestId: body.requestId };
  }
  let parsed: unknown;
  try { parsed = await res.json(); } catch { parsed = undefined; }
  const payload = isObject(parsed) ? parsed : {};
  if (res.status === 200) return { kind: "succeeded", requestId: body.requestId, result: payload, replayed: false };
  if (res.status === 401) redirectToSignIn(path);
  if (typeof payload.code === "string") {
    return { kind: "refused", status: res.status, code: payload.code,
      message: typeof payload.error === "string" ? payload.error : payload.code,
      ...(payload.method === "totp" || payload.method === "password" ? { method: payload.method } : {}) };
  }
  return { kind: "uncertain", requestId: body.requestId };
}

// ── pause new entries (OD-3) ─────────────────────────────────────────────────

export type EntriesBotHalf =
  | { state: "succeeded"; changed: boolean | null; canceled: { orderId: string; symbol: string; outcome: string }[] | null }
  | { state: "pending" }
  | { state: "uncertain" }
  | { state: "refused"; code: string; message: string };

export type EntriesAnswer =
  | { kind: "answered"; requestId: string; platform: { paused: boolean; at: string | null; changed: boolean }; bot: EntriesBotHalf }
  | { kind: "refused"; status: number; code: string; message: string; method?: "totp" | "password" }
  | { kind: "uncertain"; requestId: string };

async function sendEntries(body: Record<string, unknown> & { requestId: string }): Promise<EntriesAnswer> {
  const path = "/api/bot/control/entries";
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  } catch {
    return { kind: "uncertain", requestId: body.requestId };
  }
  let parsed: unknown;
  try { parsed = await res.json(); } catch { parsed = undefined; }
  const payload = isObject(parsed) ? parsed : {};
  if (res.status === 200 && isObject(payload.platform) && isObject(payload.bot)) {
    const p = payload.platform;
    return { kind: "answered", requestId: body.requestId,
      platform: { paused: p.paused === true, at: typeof p.at === "string" ? p.at : null, changed: p.changed === true },
      bot: entriesBotHalf(payload.bot) };
  }
  if (res.status === 401) redirectToSignIn(path);
  if (res.status >= 400 && typeof payload.code === "string") {
    return { kind: "refused", status: res.status, code: payload.code,
      message: typeof payload.error === "string" ? payload.error : payload.code,
      ...(payload.method === "totp" || payload.method === "password" ? { method: payload.method } : {}) };
  }
  return { kind: "uncertain", requestId: body.requestId };
}

/** The Bot half of a pause answer, read without assuming anything the Bot did not say. */
export function entriesBotHalf(bot: Record<string, unknown>): EntriesBotHalf {
  if (bot.status === "succeeded" && isObject(bot.result)) {
    const r = bot.result;
    const canceled = Array.isArray(r.canceledEntries)
      ? r.canceledEntries.filter(isObject).map((c) => ({ orderId: String(c.orderId), symbol: String(c.symbol), outcome: String(c.outcome) }))
      : null;
    return { state: "succeeded", changed: typeof r.changed === "boolean" ? r.changed : null, canceled };
  }
  if (bot.status === "pending") return { state: "pending" };
  if (typeof bot.code === "string" && bot.status !== "uncertain") {
    return { state: "refused", code: bot.code, message: typeof bot.error === "string" ? bot.error : bot.code };
  }
  return { state: "uncertain" };
}
