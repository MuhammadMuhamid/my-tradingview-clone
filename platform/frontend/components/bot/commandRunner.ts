"use client";
/**
 * Running a Bot command and telling the truth about what happened.
 *
 * ── Request ids (contract F6e) ─────────────────────────────────────────────
 *
 * One id per user intent. While the outcome of an intent is unknown (a 202
 * "uncertain", a pending exchange order, or a polling window that ran out),
 * doing the same thing again reuses the same id, so the Bot answers from its
 * record instead of running it twice. After any definitive answer the intent
 * is closed and the next attempt is a new intent with a new id.
 *
 * ── Unknown outcomes (contract §0.7, F8, F9) ───────────────────────────────
 *
 * "Outcome unknown, checking…" polls C8 with the same id, at most once every
 * two seconds and for at most sixty, then settles on what C8 said. Nothing
 * here ever reports success it did not read, and "Nothing was changed" is
 * said only when C8 answers that the Bot has no record of the id.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { botControlApi, type BotCommandAnswer, type BotCommandLookup, type BotCommandRecord } from "@/lib/api";
import { STEP_UP_CODES, explainRefusal } from "./botCopy";

const DEFAULT_POLLING = { intervalMs: 2_000, windowMs: 60_000 };
let polling = { ...DEFAULT_POLLING };

/** Tests only: poll faster than a person would. */
export function setCommandPollingForTests(next: { intervalMs: number; windowMs: number } | null): void {
  polling = next ? { ...next } : { ...DEFAULT_POLLING };
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `^[A-Za-z0-9_-]{16,128}$`, from the browser's CSPRNG. */
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `bot_${c.randomUUID()}`;
  const bytes = new Uint8Array(24);
  c.getRandomValues(bytes);
  return `bot_${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("")}`;
}

/** Ids of intents whose outcome is still unknown, keyed by what the intent is. */
export class OpenIntents {
  private readonly open = new Map<string, string>();
  idFor(intent: string): string { return this.open.get(intent) ?? newRequestId(); }
  keepOpen(intent: string, requestId: string): void { this.open.set(intent, requestId); }
  close(intent: string): void { this.open.delete(intent); }
  isOpen(intent: string): boolean { return this.open.has(intent); }
}

export type Verdict =
  | { state: "succeeded"; record: BotCommandRecord }
  | { state: "failed"; code: string | null; message: string }
  | { state: "not_found" }
  | { state: "still_unknown" };

/**
 * Ask C8 until it gives a terminal answer or the window closes. Pure apart from
 * the injected lookup and clock, so the budget is testable without waiting.
 */
export async function settleUncertain(requestId: string, deps: {
  lookup: (requestId: string) => Promise<BotCommandLookup>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  windowMs?: number;
  cancelled?: () => boolean;
}): Promise<Verdict> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? polling.intervalMs;
  const windowMs = deps.windowMs ?? polling.windowMs;
  const started = now();
  for (;;) {
    await sleep(intervalMs);
    if (deps.cancelled?.()) return { state: "still_unknown" };
    if (now() - started > windowMs) return { state: "still_unknown" };
    const answer = await deps.lookup(requestId);
    if (answer.kind === "not_found") return { state: "not_found" };
    if (answer.kind === "found") {
      const record = answer.record;
      if (record.status === "succeeded") return { state: "succeeded", record };
      if (record.status === "failed") {
        return { state: "failed", code: record.code ?? null, message: record.error ?? "The Bot recorded this command as failed." };
      }
      if (record.status === "pending" && record.live?.outcome === "executed") return { state: "succeeded", record };
      if (record.status === "pending" && record.live?.outcome === "not_executed") {
        return { state: "failed", code: "not_executed", message: "The exchange did not execute the order." };
      }
    }
    // processing, pending, or C8 itself unreachable: keep asking within the budget.
  }
}

// ── the outcome list a page shows ────────────────────────────────────────────

export type Outcome =
  | { id: string; label: string; phase: "checking"; requestId: string; pending?: boolean }
  | { id: string; label: string; phase: "succeeded"; message: string }
  | { id: string; label: string; phase: "refused"; message: string; chart?: string | null; profile?: boolean }
  | { id: string; label: string; phase: "nothing_changed"; message: string }
  | { id: string; label: string; phase: "unknown"; requestId: string; message: string };

export interface CommandSpec {
  /** What the intent IS: same kind, target and parameters means the same intent. */
  intent: string;
  /** "Halt the Bot", "Close BTCUSDT" — the outcome list's heading for this one. */
  label: string;
  send: (requestId: string) => Promise<BotCommandAnswer>;
  /** Plain words for a success, from the Bot's own result. */
  describe?: (result: Record<string, unknown>) => string;
  /** Where a `trade_manual` refusal should send the operator. */
  chartHref?: string | null;
}

/** What the confirm dialog does with the answer: stay open with an error, or close. */
export type DialogResult = { close: true } | { close: false; error: string; method?: "totp" | "password" };

export function useBotCommands(onSettled: () => void) {
  const intents = useRef(new OpenIntents());
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const alive = useRef(true);
  /*
   * Set in the effect BODY, not only cleared in its cleanup: React StrictMode
   * (and any future remount) runs mount → unmount → mount, and a ref that is
   * only ever cleared stays false after the second mount — every outcome was
   * then dropped and C8 polling cancelled at once (walkthrough D-1).
   */
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const put = useCallback((outcome: Outcome) => {
    if (!alive.current) return;
    setOutcomes((list) => [outcome, ...list.filter((o) => o.id !== outcome.id)].slice(0, 6));
  }, []);

  /** Outcomes being asked about right now: one C8 loop per request id, never two (F9 budget). */
  const checking = useRef(new Set<string>());

  const check = useCallback(async (spec: Pick<CommandSpec, "intent" | "label" | "describe">, id: string,
    requestId: string, pending = false) => {
    put({ id, label: spec.label, phase: "checking", requestId, pending });
    if (checking.current.has(id)) return;
    checking.current.add(id);
    let verdict: Verdict;
    try {
      verdict = await settleUncertain(requestId, { lookup: botControlApi.command, cancelled: () => !alive.current });
    } finally {
      checking.current.delete(id);
    }
    if (!alive.current) return;
    if (verdict.state === "succeeded") {
      intents.current.close(spec.intent);
      const result = verdict.record.result && typeof verdict.record.result === "object"
        ? verdict.record.result as Record<string, unknown> : {};
      put({ id, label: spec.label, phase: "succeeded", message: spec.describe?.(result) ?? "Done, as the Bot recorded it." });
    } else if (verdict.state === "failed") {
      intents.current.close(spec.intent);
      put({ id, label: spec.label, phase: "refused",
        message: verdict.code ? explainRefusal(verdict.code, verdict.message).text : verdict.message });
    } else if (verdict.state === "not_found") {
      intents.current.close(spec.intent);
      put({ id, label: spec.label, phase: "nothing_changed",
        message: "Nothing was changed. The Bot has no record of this command." });
    } else {
      put({ id, label: spec.label, phase: "unknown", requestId,
        message: "Outcome still unknown. Check the Bot status and trades before trying again; doing the same thing "
          + "again is answered from the Bot's record, never run twice." });
    }
    onSettled();
  }, [onSettled, put]);

  const run = useCallback(async (spec: CommandSpec): Promise<DialogResult> => {
    const requestId = intents.current.idFor(spec.intent);
    const answer = await spec.send(requestId);
    const id = `${spec.intent}|${requestId}`;
    if (answer.kind === "refused") {
      // Refused before anything was sent: the dialog says why and stays open.
      if (STEP_UP_CODES.has(answer.code)) {
        return { close: false, error: answer.message, ...(answer.method ? { method: answer.method } : {}) };
      }
      intents.current.close(spec.intent);
      const words = explainRefusal(answer.code, answer.message);
      put({ id, label: spec.label, phase: "refused", message: words.text,
        chart: words.chart ? spec.chartHref ?? null : null, profile: words.profile });
      return { close: true };
    }
    if (answer.kind === "succeeded") {
      intents.current.close(spec.intent);
      put({ id, label: spec.label, phase: "succeeded", message: spec.describe?.(answer.result) ?? "Done." });
      onSettled();
      return { close: true };
    }
    intents.current.keepOpen(spec.intent, requestId);
    void check(spec, id, requestId, answer.kind === "pending");
    return { close: true };
  }, [check, onSettled, put]);

  /** "Check again" on an outcome that stayed unknown: the same id, a fresh window. */
  const recheck = useCallback((outcome: Extract<Outcome, { phase: "unknown" }>) => {
    const intent = outcome.id.slice(0, outcome.id.lastIndexOf("|"));
    void check({ intent, label: outcome.label }, outcome.id, outcome.requestId);
  }, [check]);

  const dismiss = useCallback((id: string) => setOutcomes((list) => list.filter((o) => o.id !== id)), []);

  return { outcomes, run, recheck, dismiss, intents: intents.current };
}
