import type { DeploymentRow } from "../types/deployments";
import { validateWebhookUrl } from "../alerts/dispatcher";

export interface BotOperationalStatus {
  service: { reachable: true; name: string; version: string | null };
  execution: {
    mode: "DRY_RUN" | "HALTED" | "LIVE";
    dryRun: boolean;
    halted: boolean;
    haltedBy: string | null;
    haltedReason: string | null;
  };
  exchange: {
    mode: "TESTNET" | "MAINNET" | "MIXED";
    processDefault: "TESTNET" | "MAINNET";
    configuredAccounts: { total: number; testnet: number; mainnet: number };
  };
  realisedPnl: {
    currency: "USDT";
    today: number;
    dayStart: string;
    timezone: "UTC";
    rollingWindowHours: number;
    rolling: number;
  };
  openTrades: { count: number; exposureQuote: number; currency: "USDT" };
  dailyLossProtection: {
    authority: "BOT";
    limitQuote: number | null;
    windowHours: number;
    realisedPnlInWindow: number;
    enabled: boolean;
  };
  time: string;
}

export type BotStatusConnection =
  | { state: "CONNECTED"; configuredEndpoints: number; status: BotOperationalStatus }
  | { state: "NOT_CONFIGURED"; configuredEndpoints: 0; reason: "no_custom_bot_deployment" }
  | {
      state: "UNAVAILABLE";
      configuredEndpoints: number;
      reason: "authentication_rejected" | "request_failed" | "invalid_response";
    };

interface Candidate { url: string; secret: string }

export function botStatusCandidates(
  deployments: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">[]
): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const deployment of deployments) {
    if (deployment.delivery !== "custom" || !deployment.webhookUrl || !deployment.secret) continue;
    try {
      const url = new URL(deployment.webhookUrl);
      if (!/\/signal_bots\/?$/.test(url.pathname)) continue;
      url.pathname = url.pathname.replace(/\/signal_bots\/?$/, "/signal_bots/operations");
      const validated = validateWebhookUrl(url.toString());
      const key = `${validated}\u0000${deployment.secret}`;
      candidates.set(key, { url: validated, secret: deployment.secret });
    } catch {
      // Invalid/unsafe endpoints are not contacted and credentials are not sent.
    }
  }
  return [...candidates.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime guard for the cross-repository response. Reject guesses and drift. */
export function isBotOperationalStatus(value: unknown): value is BotOperationalStatus {
  if (!isRecord(value)) return false;
  const service = value.service;
  const execution = value.execution;
  const exchange = value.exchange;
  const pnl = value.realisedPnl;
  const open = value.openTrades;
  const protection = value.dailyLossProtection;
  return isRecord(service) && service.reachable === true && typeof service.name === "string"
    && (service.version === null || typeof service.version === "string")
    && isRecord(execution) && ["DRY_RUN", "HALTED", "LIVE"].includes(String(execution.mode))
    && typeof execution.dryRun === "boolean" && typeof execution.halted === "boolean"
    && isRecord(exchange) && ["TESTNET", "MAINNET", "MIXED"].includes(String(exchange.mode))
    && isRecord(pnl) && typeof pnl.today === "number" && Number.isFinite(pnl.today)
    && typeof pnl.rolling === "number" && Number.isFinite(pnl.rolling)
    && typeof pnl.dayStart === "string" && pnl.timezone === "UTC"
    && isRecord(open) && typeof open.count === "number" && typeof open.exposureQuote === "number"
    && isRecord(protection) && protection.authority === "BOT"
    && typeof protection.enabled === "boolean" && typeof value.time === "string";
}

export async function readBotStatus(
  deployments: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">[],
  fetchImpl: typeof fetch = fetch
): Promise<BotStatusConnection> {
  const candidates = botStatusCandidates(deployments);
  if (candidates.length === 0) {
    return { state: "NOT_CONFIGURED", configuredEndpoints: 0, reason: "no_custom_bot_deployment" };
  }

  const candidate = candidates[0]!;
  try {
    const response = await fetchImpl(candidate.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: candidate.secret }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        state: "UNAVAILABLE",
        configuredEndpoints: candidates.length,
        reason: response.status === 401 ? "authentication_rejected" : "request_failed",
      };
    }
    const body: unknown = await response.json();
    if (!isBotOperationalStatus(body)) {
      return { state: "UNAVAILABLE", configuredEndpoints: candidates.length, reason: "invalid_response" };
    }
    return { state: "CONNECTED", configuredEndpoints: candidates.length, status: body };
  } catch {
    return { state: "UNAVAILABLE", configuredEndpoints: candidates.length, reason: "request_failed" };
  }
}
