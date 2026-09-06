"use client";
/**
 * Alerts this chart's own alerts actually fired, as the server recorded them.
 *
 * Scoped to one instrument and timeframe, in SQL. That is the whole reason
 * this is a hook per pane rather than one fetch for the workspace: unscoped,
 * the endpoint returns the newest events across every alert on the account, so
 * a user with busy alerts elsewhere pushes this chart's out of the window —
 * and a chart that sees none would be stating that none had fired, which is a
 * negative it cannot know.
 *
 * Polled rather than pushed: an event is a historical fact about a closed bar,
 * and a mark that appears within a minute is as timely as the fact is.
 */
import { useEffect, useState } from "react";
import { api, type MaAlertEvent } from "@/lib/api";
import type { Interval } from "@/lib/types";

const POLL_MS = 60_000;
const NONE: MaAlertEvent[] = [];

export function useAlertEvents(
  symbol: string, timeframe: Interval, enabled = true
): MaAlertEvent[] {
  const [events, setEvents] = useState<MaAlertEvent[]>(NONE);

  useEffect(() => {
    if (!enabled) { setEvents(NONE); return; }
    let live = true;
    const load = (): void => {
      void api.maAlertEvents(200, { symbol, timeframe })
        .then((rows) => { if (live) setEvents(rows.length > 0 ? rows : NONE); })
        // The marks are an annotation. A failure leaves them off rather than
        // taking anything else down with it.
        .catch(() => { if (live) setEvents(NONE); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [symbol, timeframe, enabled]);

  return events;
}
