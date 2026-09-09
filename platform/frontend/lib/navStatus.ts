"use client";
/**
 * The two live readouts the navigation carries, as hooks.
 *
 * They were written inline inside `components/Nav`, which was fine while there
 * was one navigation. FC2-H3 removed the horizontal product bar from the chart
 * workspace and replaced it with a product-mark menu on the chart toolbar
 * (`components/tv/ProductMenu`), so the same two answers — "is price
 * streaming into this tab" and "is the system healthy" — are now needed in two
 * places. Two copies of a polling effect is how one of them ends up polling at
 * a different interval, or surviving a route change the other does not.
 */
import { useEffect, useState } from "react";
import { api, type OpsStatus } from "@/lib/api";
import { compactHealth, type HealthTone } from "@/lib/operationsHealth";
import { describeStreamState, marketStreams, type StreamState } from "@/lib/marketStream";

/** Tailwind background for each health tone, so both menus dot alike. */
export const HEALTH_DOT: Record<HealthTone, string> = {
  positive: "bg-up",
  neutral: "bg-ink-faint",
  warning: "bg-warn",
  critical: "bg-down",
  halted: "bg-down",
};

export interface OpsHealth {
  tone: HealthTone;
  /** One word: "Healthy", "Attention", "Unknown", or "…" while first reading. */
  label: string;
  /** The sentence behind the word — always safe to show in a title. */
  summary: string;
}

/**
 * System health, polled once a minute and only while the tab is visible.
 *
 * A background tab asking the operations endpoint every minute for an answer
 * nobody is looking at is the kind of thing that shows up in a log as load.
 */
export function useOpsHealth(): OpsHealth {
  const [ops, setOps] = useState<OpsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      try {
        const next = await api.opsStatus();
        if (live) { setOps(next); setError(null); }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  /*
   * A malformed payload is an unreadable status, not a crash.
   *
   * `compactHealth` walks the operations document and indexes into its
   * sections; a response from an older backend, a proxy error page parsed as
   * JSON, or a partially-rolled-out field makes it throw. That used to be
   * survivable because only the header read it, and the header is not on the
   * chart. It is now read by the chart workspace's own product menu, so an
   * unexpected shape here would take the chart down with it — which is the
   * exact trade a status indicator must never make.
   */
  if (ops) {
    try {
      const health = compactHealth(ops);
      return { tone: health.tone, label: health.status, summary: health.summary };
    } catch (e) {
      return {
        tone: "neutral",
        label: "Unknown",
        summary: `Operations status could not be read: ${(e as Error).message}`,
      };
    }
  }
  if (error) {
    return { tone: "neutral", label: "Unknown", summary: `Operations status could not be read: ${error}` };
  }
  return { tone: "neutral", label: "…", summary: "Reading system status…" };
}

export interface StreamSummary {
  state: StreamState;
  label: string;
  detail: string;
  /** Tailwind background for the dot. */
  dot: string;
}

/**
 * Whether prices are streaming into this tab.
 *
 * `null` while no market socket is held at all — a page with no market view
 * should carry no claim about market data, rather than an idle-looking one.
 */
export function useStreamSummary(): StreamSummary | null {
  const [state, setState] = useState<StreamState | null>(null);

  useEffect(() => {
    const summarise = (): void => {
      const states = [...marketStreams.states().values()];
      if (states.length === 0) { setState(null); return; }
      // The worst stream is the tab's answer: one refused socket is a problem
      // even while another is live.
      const rank = (s: StreamState): number => ({
        live: 0, open: 1, connecting: 1, idle: 2, reconnecting: 3, stale: 4,
      })[s.status];
      setState(states.reduce((worst, s) => (rank(s) > rank(worst) ? s : worst)));
    };
    summarise();
    return marketStreams.observe(summarise);
  }, []);

  if (!state) return null;
  const words = describeStreamState(state);
  const dot = state.status === "live" ? "bg-up"
    : state.status === "stale" ? "bg-down"
    : state.status === "reconnecting" ? "bg-warn" : "bg-ink-faint";
  return {
    state,
    label: state.status === "live" ? "Live data" : words.label,
    detail: words.detail,
    dot,
  };
}
