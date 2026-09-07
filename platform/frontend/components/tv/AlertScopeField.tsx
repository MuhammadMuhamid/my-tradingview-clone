"use client";
import { useEffect, useState } from "react";
import { api, type ServerWatchlist } from "@/lib/api";

/**
 * Which symbols an alert is armed on.
 *
 * "The same 15m support alert on every coin in my watchlist" is one decision,
 * not forty repetitions of the same dialog. The scope is chosen here and the
 * symbols travel to the server in a single request — see `symbols` on
 * `POST /api/ma-alerts`.
 *
 * Deliberately NOT offered on price alerts: a price level is a fact about one
 * instrument, and "BTC crosses 64,000" applied to forty coins is forty alerts
 * that are wrong about thirty-nine of them.
 *
 * The count is always shown, and the create button carries the real total,
 * because arming forty coins across four timeframes is a hundred and sixty
 * alerts and that should never be a surprise.
 */
export function AlertScopeField({
  symbol, value, onChange,
}: {
  /** The chart's own symbol, used when the scope is "this one". */
  symbol: string;
  /** The chosen watchlist id, or null for just this symbol. */
  value: string | null;
  onChange: (watchlistId: string | null, symbols: string[]) => void;
}) {
  const [lists, setLists] = useState<ServerWatchlist[] | null>(null);

  useEffect(() => {
    let live = true;
    api.listWatchlists()
      .then((w) => { if (live) setLists(w); })
      // A watchlist that cannot be read is not a reason to block arming the
      // alert on the symbol in front of you, so this degrades to that.
      .catch(() => { if (live) setLists([]); });
    return () => { live = false; };
  }, []);

  const chosen = lists?.find((l) => l.id === value) ?? null;

  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-3">
      <span className="pt-2 text-sm text-ink-muted">Apply to</span>
      <div className="space-y-1">
        <select
          value={value ?? ""}
          aria-label="Which symbols to arm"
          onChange={(e) => {
            const id = e.target.value || null;
            const list = lists?.find((l) => l.id === id);
            onChange(id, id && list ? list.symbols : [symbol]);
          }}
          className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="">{symbol} only</option>
          {(lists ?? []).map((l) => (
            <option key={l.id} value={l.id} disabled={l.symbols.length === 0}>
              {l.name} — {l.symbols.length} coin{l.symbols.length === 1 ? "" : "s"}
              {l.symbols.length === 0 ? " (empty)" : ""}
            </option>
          ))}
        </select>
        {chosen && chosen.symbols.length > 0 && (
          <p className="text-xs text-ink-faint">
            One alert per coin per timeframe, each watching its own market. They
            are ordinary alerts afterwards — edit or remove them one at a time
            from the Alerts page.
          </p>
        )}
      </div>
    </div>
  );
}
