"use client";
import type { Alert } from "@/lib/types";
import { StatusBadge } from "@/components/ui";
import { fmtPrice, fmtAgo, fmtDateTime } from "@/lib/format";

export function AlertFeed({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-ink-faint">No signals fired yet.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular">
        <thead>
          <tr className="border-b border-border text-left text-xs text-ink-muted">
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">Reason</th>
            <th className="px-4 py-2 font-medium text-right">Price</th>
            <th className="px-4 py-2 font-medium">Bar time</th>
            <th className="px-4 py-2 font-medium">Delivery</th>
            <th className="px-4 py-2 font-medium text-right">HTTP</th>
            <th className="px-4 py-2 font-medium">Fired</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id} className="border-b border-border/50 hover:bg-surface-2">
              <td className="px-4 py-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${a.action === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>
                  {a.action}
                </span>
              </td>
              <td className="px-4 py-2 text-ink-muted">{a.reason ?? "—"}</td>
              <td className="px-4 py-2 text-right">{fmtPrice(a.triggerPrice)}</td>
              <td className="px-4 py-2 text-ink-muted">{fmtDateTime(a.barTime)}</td>
              <td className="px-4 py-2"><StatusBadge status={a.deliveryStatus} /></td>
              <td className="px-4 py-2 text-right text-ink-muted">{a.httpStatus ?? "—"}{a.attempts > 1 ? ` (${a.attempts}×)` : ""}</td>
              <td className="px-4 py-2 text-ink-faint">{fmtAgo(a.firedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
