"use client";
import { useEffect, useState } from "react";
import { freshnessNotice, type Freshness } from "@/lib/freshness";

/**
 * Says when the page has stopped updating.
 *
 * It re-renders on its own timer rather than only when a poll returns: a page
 * whose polls are all failing produces no renders at all, which is exactly when
 * this most needs to appear.
 */
export function StaleNotice({ state }: { state: Freshness }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  const notice = freshnessNotice(state, Date.now());
  if (!notice.show) return null;

  const tone = notice.severity === "down"
    ? "border-down/40 bg-down/10 text-down"
    : "border-warn/40 bg-warn/10 text-warn";

  return (
    // `status` rather than `alert`: it is important, but it should not
    // interrupt a screen-reader user mid-sentence every time a poll fails.
    <div role="status" className={`rounded-md border px-3 py-2 text-xs ${tone}`}>
      {notice.message}
    </div>
  );
}
