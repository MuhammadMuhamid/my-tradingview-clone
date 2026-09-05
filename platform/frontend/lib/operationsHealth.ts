import type { OpsStatus } from "./api";

export type HealthTone = "positive" | "neutral" | "warning" | "critical" | "halted";
export type HealthImpact = "normal" | "attention" | "degraded" | "neutral";

export interface HealthItem {
  id: "market-data" | "live-runner" | "alerts" | "scanner" | "database" | "delivery" | "trading-mode";
  name: string;
  status: string;
  tone: HealthTone;
  impact: HealthImpact;
  summary: string;
  facts: string[];
  source: string;
}

export interface ScannerHealthContract {
  ok: boolean;
  exchange?: string;
  symbols?: number;
  resolved?: number;
  unresolved?: number;
  timeframes?: string[];
  last_refresh_at?: number | null;
  last_refresh_error?: string | null;
}

export interface ScannerEvidence {
  loading?: boolean;
  value?: unknown;
  error?: string;
}

export interface OperationsOverview {
  status: "Healthy" | "Attention" | "Degraded" | "Halted";
  tone: HealthTone;
  summary: string;
  items: HealthItem[];
}

const ISSUE_LABELS: Record<string, string> = {
  duplicate_timestamp: "duplicate candle timestamps",
  out_of_order_timestamp: "out-of-order candles",
  missing_completed_interval: "missing completed intervals",
  malformed_ohlc: "malformed OHLC values",
  malformed_numeric: "malformed numeric values",
  stale_latest_completed_bar: "stale latest completed candle",
};

function issueText(code: string): string {
  return ISSUE_LABELS[code] ?? code.replaceAll("_", " ");
}

function marketData(status: OpsStatus): HealthItem {
  const rows = status.feeds.rows;
  if (rows.length === 0) {
    return {
      id: "market-data", name: "Market data", status: "Unknown", tone: "neutral",
      impact: "attention", summary: "No feed has been assessed yet.", facts: [],
      source: "Incremental feed_health evidence from /api/ops/status",
    };
  }
  const ranked = [...rows].sort((a, b) => {
    const rank = { invalid: 2, degraded: 1, healthy: 0, unknown: 1 } as const;
    return (rank[b.integrity.state ?? "unknown"] ?? 1) - (rank[a.integrity.state ?? "unknown"] ?? 1);
  });
  const feed = ranked[0]!;
  const state = feed.integrity.state;
  const issue = feed.integrity.issueCodes[0];
  const issueCount = issue ? feed.integrity.issueCounts[issue] : undefined;
  const issueSummary = issue
    ? `${issueText(issue)}${issueCount === undefined ? "" : ` (${issueCount})`}`
    : feed.detail || "The feed is not currently evaluable.";
  const facts = [
    `${feed.integrity.symbol} · ${feed.integrity.interval} · Spot`,
    feed.integrity.latestCompletedBarAgeMs === null
      ? "Latest completed candle: no evidence"
      : `Latest completed candle age: ${formatDuration(feed.integrity.latestCompletedBarAgeMs)}`,
    `Last checked: ${formatTimestamp(feed.integrity.lastCheckedAt)}`,
  ];
  if (state === "invalid") {
    return {
      id: "market-data", name: "Market data", status: "Invalid", tone: "critical",
      impact: "degraded", summary: issueSummary, facts,
      source: "Incremental candle-integrity evidence from /api/ops/status",
    };
  }
  if (state === "degraded") {
    return {
      id: "market-data", name: "Market data", status: "Degraded", tone: "warning",
      impact: "attention", summary: issueSummary, facts,
      source: "Incremental candle-integrity evidence from /api/ops/status",
    };
  }
  if (state !== "healthy" || rows.some((row) => row.integrity.state !== "healthy")) {
    return {
      id: "market-data", name: "Market data", status: "Unknown", tone: "neutral",
      impact: "attention", summary: "At least one assessed feed lacks conclusive integrity evidence.", facts,
      source: "Incremental candle-integrity evidence from /api/ops/status",
    };
  }
  return {
    id: "market-data", name: "Market data", status: "Healthy", tone: "positive",
    impact: "normal", summary: `${rows.length} feed${rows.length === 1 ? "" : "s"} current and structurally valid.`,
    facts, source: "Incremental candle-integrity evidence from /api/ops/status",
  };
}

function liveRunner(status: OpsStatus): HealthItem {
  if (!status.emitter.liveRunnerEnabled) {
    return {
      id: "live-runner", name: "Live runner", status: "Disabled", tone: "neutral",
      impact: "neutral", summary: "Live emission is intentionally disabled by configuration.",
      facts: [`${status.deployments.active} active deployment(s)`],
      source: "Live runner configuration and emitter lease from /api/ops/status",
    };
  }
  if (status.emitter.holdsLease) {
    return {
      id: "live-runner", name: "Live runner", status: "Healthy", tone: "positive",
      impact: "normal", summary: "This process holds the emitter lease.",
      facts: [
        `${status.deployments.active} active · ${status.deployments.paused} paused`,
        `Lease expires: ${formatTimestamp(status.emitter.lease?.expiresAt ?? null)}`,
      ], source: "Live runner configuration and emitter lease from /api/ops/status",
    };
  }
  if (status.emitter.lease) {
    return {
      id: "live-runner", name: "Live runner", status: "Standby", tone: "neutral",
      impact: "neutral", summary: "Another process holds the emitter lease; this process will not emit.",
      facts: [`Lease holder: ${status.emitter.lease.holder}`],
      source: "Live runner configuration and emitter lease from /api/ops/status",
    };
  }
  return {
    id: "live-runner", name: "Live runner", status: "Attention", tone: "warning",
    impact: "attention", summary: "The live runner is enabled, but no emitter lease is visible.",
    facts: [`${status.deployments.active} active deployment(s)`],
    source: "Live runner configuration and emitter lease from /api/ops/status",
  };
}

function alertRunner(status: OpsStatus): HealthItem {
  const runner = status.alertRunner;
  const map = {
    healthy: { label: "Healthy", tone: "positive", impact: "normal" },
    degraded: { label: "Degraded", tone: "warning", impact: "attention" },
    unknown: { label: "No recent evidence", tone: "neutral", impact: "attention" },
    disabled: { label: "Disabled", tone: "neutral", impact: "neutral" },
    not_configured: { label: "Not configured", tone: "neutral", impact: "neutral" },
  } as const;
  const presentation = map[runner.state];
  return {
    id: "alerts", name: "Alerts", status: presentation.label,
    tone: presentation.tone, impact: presentation.impact, summary: runner.reason,
    facts: [
      `${runner.active} active · ${runner.recent} recent · ${runner.stale} stale`,
      `Last evaluated: ${formatTimestamp(runner.lastEvaluatedAt)}`,
    ], source: "Active alert evaluation watermarks from /api/ops/status (not configuration alone)",
  };
}

function scanner(evidence: ScannerEvidence): HealthItem {
  if (evidence.loading) {
    return {
      id: "scanner", name: "Scanner", status: "Loading", tone: "neutral", impact: "neutral",
      summary: "Reading Scanner health evidence…", facts: [], source: "/api/scanner/health",
    };
  }
  if (evidence.error) {
    const unconfigured = evidence.error.toLowerCase().includes("not configured");
    return {
      id: "scanner", name: "Scanner", status: unconfigured ? "Not configured" : "Unavailable",
      tone: unconfigured ? "neutral" : "critical", impact: unconfigured ? "attention" : "degraded",
      summary: evidence.error, facts: [], source: "/api/scanner/health",
    };
  }
  const value = evidence.value as Partial<ScannerHealthContract> | undefined;
  if (!value || value.ok !== true) {
    return {
      id: "scanner", name: "Scanner", status: "Unknown", tone: "neutral", impact: "attention",
      summary: "Scanner health returned no recognized evidence.", facts: [], source: "/api/scanner/health",
    };
  }
  if (value.last_refresh_error) {
    return {
      id: "scanner", name: "Scanner", status: "Degraded", tone: "warning", impact: "attention",
      summary: value.last_refresh_error,
      facts: [
        `${value.resolved ?? 0} resolved · ${value.unresolved ?? 0} unresolved symbols`,
        `Last refresh: ${formatTimestamp(value.last_refresh_at ?? null)}`,
      ], source: "Scanner service /api/health via /api/scanner/health",
    };
  }
  if (value.last_refresh_at === null || value.last_refresh_at === undefined) {
    return {
      id: "scanner", name: "Scanner", status: "No recent evidence", tone: "neutral", impact: "attention",
      summary: "Scanner is reachable but has not recorded a refresh.", facts: [],
      source: "Scanner service /api/health via /api/scanner/health",
    };
  }
  const unresolved = value.unresolved ?? 0;
  return {
    id: "scanner", name: "Scanner", status: unresolved > 0 ? "Attention" : "Healthy",
    tone: unresolved > 0 ? "warning" : "positive", impact: unresolved > 0 ? "attention" : "normal",
    summary: unresolved > 0
      ? `${unresolved} configured symbol${unresolved === 1 ? " is" : "s are"} unresolved.`
      : "Service is reachable and its last refresh reported no error.",
    facts: [
      `${value.resolved ?? 0} resolved · ${unresolved} unresolved symbols`,
      `Last refresh: ${formatTimestamp(value.last_refresh_at)}`,
    ], source: "Scanner service /api/health via /api/scanner/health",
  };
}

function database(status: OpsStatus): HealthItem {
  const db = status.database;
  if (db.ready) {
    return {
      id: "database", name: "Database", status: "Healthy", tone: "positive", impact: "normal",
      summary: "Database is reachable and the shipped schema is current.",
      facts: [`${db.schema.applied}/${db.schema.expected} migrations applied`, `Checked: ${formatTimestamp(db.time)}`],
      source: "Existing database readiness check, included in /api/ops/status",
    };
  }
  const databaseUnavailable = db.checks.database === "unavailable";
  return {
    id: "database", name: "Database", status: "Degraded", tone: "critical", impact: "degraded",
    summary: databaseUnavailable ? "Database readiness check failed." : `Database schema is ${db.checks.schema}.`,
    facts: db.schema?.missing.length ? [`Missing: ${db.schema.missing.join(", ")}`] : [],
    source: "Existing database readiness check, included in /api/ops/status",
  };
}

function delivery(status: OpsStatus): HealthItem {
  const state = status.delivery.state;
  const presentation = state === "healthy"
    ? { label: "Healthy", tone: "positive", impact: "normal" }
    : state === "idle"
      ? { label: "No recent evidence", tone: "neutral", impact: "neutral" }
      : state === "degraded"
        ? { label: "Degraded", tone: "warning", impact: "attention" }
        : { label: state === "stalled" ? "Stalled" : "Failing", tone: "critical", impact: "degraded" };
  return {
    id: "delivery", name: "Webhook delivery", status: presentation.label,
    tone: presentation.tone as HealthTone, impact: presentation.impact as HealthImpact,
    summary: status.delivery.summary,
    facts: [
      `${status.delivery.counts.sent} sent · ${status.delivery.counts.failed} failed · ${status.delivery.counts.blocked} blocked`,
      `Last delivered: ${formatTimestamp(status.delivery.lastSentAt)}`,
    ], source: `Persisted delivery outcomes, last ${status.delivery.windowHours}h`,
  };
}

function tradingMode(status: OpsStatus): HealthItem {
  const risk = status.risk;
  if (risk.tradingHalted) {
    const operator = risk.haltedBy === "operator";
    return {
      id: "trading-mode", name: "Trading Mode",
      status: operator ? "Operator halted" : "Risk blocked", tone: "halted", impact: "neutral",
      summary: operator
        ? "Trading was intentionally halted by an operator; this is not a system crash."
        : "Trading is blocked by an authoritative risk control.",
      facts: [risk.haltedReason ? `Reason: ${risk.haltedReason}` : "Reason: not recorded", `Since: ${formatTimestamp(risk.haltedAt)}`],
      source: "Latched risk state from /api/ops/status",
    };
  }
  if (status.bot.state === "UNAVAILABLE") {
    const reason = status.bot.reason.replaceAll("_", " ");
    return {
      id: "trading-mode", name: "Trading Mode", status: "Bot unavailable",
      tone: "critical", impact: "degraded",
      summary: "The configured execution bot did not provide authoritative operating state.",
      facts: [`Reason: ${reason}`, `${status.bot.configuredEndpoints} configured endpoint(s)`],
      source: "Credentialed execution-bot operations contract via /api/ops/status",
    };
  }
  if (status.bot.state === "CONNECTED" && status.bot.status.execution.halted) {
    return {
      id: "trading-mode", name: "Trading Mode", status: "Bot halted",
      tone: "halted", impact: "attention",
      summary: "The execution bot is intentionally refusing orders; Platform subsystem health is separate.",
      facts: [
        status.bot.status.execution.haltedReason
          ? `Reason: ${status.bot.status.execution.haltedReason}`
          : "Reason: not recorded",
        `Bot read: ${formatTimestamp(status.bot.status.time)}`,
      ], source: "Credentialed execution-bot operations contract via /api/ops/status",
    };
  }
  const botMode = status.bot.state === "CONNECTED" ? status.bot.status.execution.mode : "Unknown bot mode";
  /*
   * "Dry run" was this product's fourth name for one idea. Deployments say
   * "paper (simulated)", the Journal badges "PAPER", the delivery mode in
   * `lib/types` is `paper`, and only this line said "Dry run" — as the visible
   * Trading Mode, directly above facts that count "… paper" in the same card.
   */
  const visibleMode = status.bot.state === "CONNECTED" && status.bot.status.execution.dryRun
    ? "Paper"
    : status.mode === "LIVE" ? "Live" : status.mode;
  return {
    id: "trading-mode", name: "Trading Mode", status: visibleMode,
    tone: status.mode === "LIVE" ? "positive" : "neutral", impact: "neutral",
    summary: status.mode === "LIVE"
      ? "Platform emission is armed; execution remains subject to bot and risk controls."
      : "The current mode is intentional platform operating state, not a health verdict.",
    facts: [
      `Bot execution: ${botMode}`,
      `${status.deployments.automated} automated · ${status.deployments.paper} paper · ${status.deployments.signalOnly} signal-only`,
    ], source: "Risk latch, emitter mode, deployment delivery modes and bot status",
  };
}

export function buildOperationsOverview(status: OpsStatus, scannerEvidence: ScannerEvidence): OperationsOverview {
  const items = [
    marketData(status), liveRunner(status), alertRunner(status), scanner(scannerEvidence),
    database(status), delivery(status), tradingMode(status),
  ];
  return overviewFromItems(status, items);
}

/**
 * The one-word answer the header carries on every page.
 *
 * Same rules as the Operations page, over the subsystems a trader depends on
 * from anywhere: the Scanner is left out, because "Degraded" on every page
 * because the Screener service is not configured is alarm about a feature
 * the trader may not use. The full page still names it.
 */
export function compactHealth(status: OpsStatus): OperationsOverview {
  const items = [
    marketData(status), liveRunner(status), alertRunner(status),
    database(status), delivery(status), tradingMode(status),
  ];
  return overviewFromItems(status, items);
}

function overviewFromItems(status: OpsStatus, items: HealthItem[]): OperationsOverview {
  const botHalted = status.bot.state === "CONNECTED" && status.bot.status.execution.halted;
  if (status.risk.tradingHalted || botHalted) {
    const degraded = items.filter((item) => item.impact === "degraded").length;
    const attention = items.filter((item) => item.impact === "attention").length;
    return {
      status: "Halted", tone: "halted",
      summary: `Trading is intentionally blocked${degraded + attention > (botHalted ? 1 : 0) ? `; ${degraded + attention - (botHalted ? 1 : 0)} other subsystem${degraded + attention - (botHalted ? 1 : 0) === 1 ? " also needs" : "s also need"} attention` : "; available evidence is otherwise healthy"}.`,
      items,
    };
  }
  const degraded = items.filter((item) => item.impact === "degraded");
  if (degraded.length > 0) {
    return {
      status: "Degraded", tone: "critical",
      summary: `${degraded.map((item) => item.name).join(", ")} ${degraded.length === 1 ? "is" : "are"} not operational.`, items,
    };
  }
  const attention = items.filter((item) => item.impact === "attention");
  if (attention.length > 0) {
    return {
      status: "Attention", tone: "warning",
      summary: `${attention.map((item) => item.name).join(", ")} ${attention.length === 1 ? "needs" : "need"} attention or stronger evidence.`, items,
    };
  }
  return { status: "Healthy", tone: "positive", summary: "All configured subsystems with authoritative evidence are operational.", items };
}

export function formatTimestamp(value: string | number | null): string {
  if (value === null) return "No evidence";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid timestamp" : date.toLocaleString();
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
