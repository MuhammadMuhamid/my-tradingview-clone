"use client";

import type { ColumnSpec } from "@/lib/columns";
import {
  DIRECTION_LABEL,
  categoricalStyle,
  divergingStyle,
  fmtAdaptive,
  fmtNum,
  fmtPrice,
  fmtSigned,
  fmtTime,
  signStyle,
} from "@/lib/format";
import type { ScreenerRow, SeriesInfo } from "@/lib/types";

interface Props {
  spec: ColumnSpec;
  row: ScreenerRow;
  /** The series this column's value came from — the indicator's own timeframe. */
  series?: SeriesInfo;
}

/**
 * One table cell.
 *
 * Two rules from §7 live here: colour only ever encodes magnitude, with the
 * number always rendered beside it, and every cell exposes the close time of the
 * bar its value came from, with stale cells visibly greyed rather than hidden.
 */
export function Cell({ spec, row, series }: Props) {
  const err = spec.indicator ? row.errors[spec.indicator] : undefined;
  if (err) {
    return (
      <td className="num text-[var(--color-ink-dim)]" title={err}>
        ⚠
      </td>
    );
  }

  const value = spec.accessor(row);
  const stale = series?.stale ?? false;

  let text: string;
  let style: React.CSSProperties = {};

  switch (spec.kind) {
    case "price":
      text = fmtPrice(typeof value === "number" ? value : null);
      break;
    case "signed":
      text = fmtSigned(value, spec.digits ?? 2);
      style =
        spec.colorMode === "sign"
          ? signStyle(value)
          : divergingStyle(value, spec.saturateAt ?? 1);
      break;
    case "adaptive":
      // Price-scaled series (MACD, VFI) whose magnitude is not comparable
      // between coins: digits chosen per value, colour from the sign only.
      text = fmtAdaptive(value);
      style = spec.colorMode === "sign" ? signStyle(value) : {};
      break;
    case "number":
      text = fmtNum(value, spec.digits ?? 2);
      break;
    case "int":
      text = typeof value === "number" ? String(value) : "—";
      break;
    case "bool":
      text = value === true ? "yes" : value === false ? "no" : "—";
      style = value === true ? { backgroundColor: "rgba(13,148,136,0.22)" } : {};
      break;
    case "category":
      text = typeof value === "string" ? (DIRECTION_LABEL[value] ?? value) : "—";
      style = categoricalStyle(value);
      break;
    default:
      text = typeof value === "string" && value ? value : "—";
  }

  // For a normalised column, the underlying raw value belongs on the hover so
  // the number is never simply unavailable.
  const raw =
    spec.id.startsWith("macd_") && !spec.id.startsWith("macd_raw_") && spec.slot
      ? (row.mtf?.[spec.slot]?.macd as Record<string, unknown> | undefined)?.macd
      : undefined;

  const title = [
    `${spec.header}${spec.title ? ` — ${spec.title}` : ""}`,
    typeof raw === "number" ? `raw MACD line ${fmtAdaptive(raw)}` : null,
    series ? `timeframe ${series.timeframe}` : null,
    series ? `source bar closed ${fmtTime(series.last_close_ts)}` : null,
    stale ? "STALE — source bar is older than 2x its timeframe" : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <td className={`num ${stale ? "stale" : ""}`} style={style} title={title}>
      {text}
    </td>
  );
}
