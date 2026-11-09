import type { ChartPriceLine } from "@/components/CandleChart";
import type { ManualPosition, ManualTradingState } from "@/lib/api";

/**
 * Is this manual position protected, as far as the execution bot says?
 *
 * The bot's protection poller checks ONLY positions whose `protectionState` is
 * `active` (and that carry a take-profit or stop-loss) — and only while it is
 * polling at all. It stops while the bot is halted or manual trading is off,
 * and it skips mainnet-account positions while mainnet manual trading is off.
 * So a position is "protected" only when every one of those is known to hold.
 * Anything unknown — including an older bot that does not report whether it
 * is polling — is never shown as protected.
 *
 * `late_fill_unprotected` is a BUY fill that arrived after its trade had
 * closed: the bot keeps it as a separate position with no TP/SL and never
 * watches it.
 */
export type ProtectionKind =
  | "protected" | "not_checked" | "none" | "triggered" | "late_fill_unprotected" | "unknown";

export interface PositionProtection {
  kind: ProtectionKind;
  label: string;
  title: string;
  /** Colour classes only (border colour, ground, ink). */
  tone: string;
}

/** What the bot says about its poller, and the position's own account. */
export interface ProtectionContext {
  /** `protection.polling`; undefined from an older bot. */
  polling: boolean | undefined;
  /** The bot's halt latch (or this Platform's halt read); undefined when unknown. */
  halted: boolean | undefined;
  /** Whether manual trading is enabled on the bot. */
  manualEnabled: boolean | undefined;
  /** The position's own account's testnet flag; undefined when the account is not listed. */
  accountTestnet: boolean | undefined;
  /** `protection.mainnetPositionsChecked`; undefined from an older bot. */
  mainnetPositionsChecked: boolean | undefined;
}

/** Nothing known: the most conservative context. */
export const UNKNOWN_PROTECTION_CONTEXT: ProtectionContext = {
  polling: undefined, halted: undefined, manualEnabled: undefined,
  accountTestnet: undefined, mainnetPositionsChecked: undefined,
};

/** The context for one position, from the bot's manual state. */
export function protectionContextFor(
  state: Pick<ManualTradingState, "enabled" | "tradingHalted" | "accounts" | "protection"> | null | undefined,
  position: Pick<ManualPosition, "exchangeAccountId">,
  platformHalted?: boolean,
): ProtectionContext {
  const account = state?.accounts?.find((candidate) => candidate.id === position.exchangeAccountId);
  return {
    polling: state?.protection?.polling,
    // Either authority saying "halted" is enough to say "not checked".
    halted: platformHalted === true || state?.tradingHalted === true ? true : state?.tradingHalted,
    manualEnabled: state?.enabled,
    accountTestnet: typeof account?.testnet === "boolean" ? account.testnet : undefined,
    mainnetPositionsChecked: state?.protection?.mainnetPositionsChecked,
  };
}

/** The bot's own value for a late fill kept as its own, unwatched position. */
export const LATE_FILL_UNPROTECTED = "late_fill_unprotected";

const DANGER = "border-down/40 bg-down/15 text-down";
const WARN = "border-warn/40 bg-warn/15 text-warn";
const QUIET = "border-border bg-surface-2 text-ink-muted";

/** Why levels that are set are not being checked; null when they are. */
function notCheckedReason(context: ProtectionContext): string | null {
  if (context.halted === true) return "Bot halted";
  if (context.manualEnabled === false) return "manual trading off";
  if (context.polling !== true) return context.polling === false ? "Bot not polling" : "status unknown";
  if (context.accountTestnet === true) return null;
  if (context.accountTestnet === false) {
    if (context.mainnetPositionsChecked === true) return null;
    return context.mainnetPositionsChecked === false ? "mainnet manual off" : "status unknown";
  }
  return "status unknown";
}

export function positionProtection(
  p: Pick<ManualPosition, "protectionState" | "manualTpPrice" | "manualSlPrice">,
  context: ProtectionContext = UNKNOWN_PROTECTION_CONTEXT,
): PositionProtection {
  const levels = p.manualTpPrice != null || p.manualSlPrice != null;
  const state = p.protectionState;
  if (state === LATE_FILL_UNPROTECTED) {
    return {
      kind: "late_fill_unprotected", label: "UNPROTECTED · late fill", tone: DANGER,
      title: "A fill that arrived after this trade had closed. The bot keeps it as its own position "
        + "with NO take-profit and NO stop-loss, and does not watch it. Set TP/SL or sell it.",
    };
  }
  if (state === "active" && levels) {
    const reason = notCheckedReason(context);
    if (reason === null) {
      return { kind: "protected", label: "TP/SL bot-managed", tone: QUIET,
        title: "At the last read the bot's poller was checking this position's take-profit / "
          + "stop-loss, about every 30 s. No order rests on the exchange." };
    }
    return {
      kind: "not_checked", label: `TP/SL NOT BEING CHECKED · ${reason}`, tone: DANGER,
      title: reason === "status unknown"
        ? "The bot did not confirm that its TP/SL poller covers this position. Treat it as unprotected."
        : `The bot is not checking this position's take-profit / stop-loss (${reason}). `
          + "The levels are saved but nothing enforces them. Treat it as unprotected.",
    };
  }
  if (state === "triggered") {
    return { kind: "triggered", label: "Protection triggered", tone: WARN,
      title: "The bot's take-profit or stop-loss fired; its exit is in progress or unresolved." };
  }
  if ((state === null || state === "none" || state === "removed") && !levels) {
    return { kind: "none", label: "No TP/SL", tone: QUIET,
      title: "No take-profit or stop-loss is set on this position." };
  }
  return {
    kind: "unknown", label: "Protection unknown", tone: WARN,
    title: `The bot reported protection state "${state ?? "none"}"${levels ? " with TP/SL levels" : ""}, `
      + "which this Platform cannot confirm is watched. Treat the position as unprotected.",
  };
}

export function ProtectionBadge({ protection }: { protection: PositionProtection }) {
  return (
    <span data-protection={protection.kind} title={protection.title}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${protection.tone}`}>
      {protection.label}
    </span>
  );
}

/**
 * The chart's "MANUAL TP/SL · BOT" price lines for the given positions (the
 * page passes the trading symbol's active ones) — drawn ONLY for a position the
 * bot is known to be checking. A late fill, an unrecognised protection state, a
 * halted or non-polling bot, or an unchecked mainnet account draws no line: a
 * level labelled as enforced that nothing enforces is the one thing the chart
 * must not draw.
 */
export function manualProtectionLines(
  state: ManualTradingState | null | undefined, positions: readonly ManualPosition[],
): ChartPriceLine[] {
  const lines: ChartPriceLine[] = [];
  for (const position of positions) {
    if (positionProtection(position, protectionContextFor(state, position)).kind !== "protected") continue;
    const tag = position.id.slice(0, 4);
    // Entry is rendered by the normalized explicit ManualPosition overlay;
    // these remain the separate Bot-managed protection levels.
    if (position.manualTpPrice != null) lines.push({ price: position.manualTpPrice, color: "#2ebd85", title: `MANUAL TP · BOT · ${tag}`, dashed: true });
    if (position.manualSlPrice != null) lines.push({ price: position.manualSlPrice, color: "#f6465d", title: `MANUAL SL · BOT · ${tag}`, dashed: true });
  }
  return lines;
}
