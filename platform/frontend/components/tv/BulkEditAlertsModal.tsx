"use client";
import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, Select } from "@/components/ui";
import { AlertFiltersField, emptyFilters } from "@/components/tv/AlertFiltersField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import { api, type AlertFilter, type AlertFrequency, type MaAlert } from "@/lib/api";
import { FREQUENCY_LABELS } from "@/lib/alerts";

/**
 * Apply ONE change to many alerts.
 *
 * "Every 15m support alert" — put the same MACD gate on all of them, or the
 * same cadence, or the same note.
 *
 * ── Only what was ticked is sent ───────────────────────────────────────────
 *
 * Each field has its own checkbox and nothing is sent unless its box is
 * ticked. A dialog that sent every field it displayed would overwrite the
 * cadence of a hundred alerts because the user came to change a note, and the
 * previous values would be gone with no way back.
 *
 * ── Gates REPLACE, they do not merge ──────────────────────────────────────
 *
 * There is no way to express "add this gate to whatever each alert already
 * has" that is honest at this scale: the alerts in a selection have different
 * gates, so "add" would produce a different result per alert and the dialog
 * could not show what any of them would become. Replace is the operation the
 * user can predict, and the warning says so plainly before they commit.
 */
export function BulkEditAlertsModal({
  open, onClose, alerts, onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** The ticked rows. The dialog never widens this to "everything shown". */
  alerts: MaAlert[];
  onDone: (message: string) => void;
}) {
  const [editFilters, setEditFilters] = useState(false);
  const [filters, setFilters] = useState<AlertFilter[]>(emptyFilters);
  const [editFrequency, setEditFrequency] = useState(false);
  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [editCooldown, setEditCooldown] = useState(false);
  const [cooldownMin, setCooldownMin] = useState(0);
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejected, setRejected] =
    useState<Array<{ symbol: string; kind: string; reason: string }>>([]);

  /**
   * The timeframes and families in the selection, for the summary line.
   *
   * Worth showing because a gate reading "chart timeframe" means something
   * different on each timeframe present, and a selection spanning families
   * cannot take a family-specific field at all.
   */
  const scope = useMemo(() => {
    const timeframes = [...new Set(alerts.map((a) => a.timeframe))];
    const kinds = [...new Set(alerts.map((a) => a.conditionKind))];
    return { timeframes, kinds };
  }, [alerts]);

  const nothingTicked = !editFilters && !editFrequency && !editCooldown && !editNote;

  const apply = async () => {
    setBusy(true); setErr(null); setRejected([]);
    const patch: Record<string, unknown> = {};
    if (editFilters) patch.filters = filters;
    if (editFrequency) patch.frequency = frequency;
    if (editCooldown) patch.cooldownMin = cooldownMin;
    // A cleared box means "no note", which is a real edit — hence null rather
    // than skipping the field.
    if (editNote) patch.note = note.trim() === "" ? null : note.trim();

    try {
      const result = await api.bulkEditMaAlerts(alerts.map((a) => a.id), patch);
      onDone(`${result.updated} alert${result.updated === 1 ? "" : "s"} updated`);
      onClose();
    } catch (error) {
      const body = (error as { body?: Record<string, unknown> }).body;
      const list = body?.rejected as typeof rejected | undefined;
      if (list?.length) setRejected(list);
      setErr(String(body?.error ?? (error as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${alerts.length} alerts`}>
      <div className="space-y-3">
        <p className="text-xs text-ink-muted">
          Changing <span className="text-ink">{alerts.length}</span> alert{alerts.length === 1 ? "" : "s"}
          {" "}on {scope.timeframes.join(", ")}
          {scope.kinds.length === 1 ? "" : ` across ${scope.kinds.length} alert types`}.
          {" "}Only the fields you tick are changed; everything else is left alone.
        </p>

        <Row
          checked={editFrequency} onChange={setEditFrequency}
          label="Frequency" id="bulk-frequency"
        >
          <Select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as AlertFrequency)}
            aria-label="Bulk frequency"
            disabled={!editFrequency}
          >
            {(Object.keys(FREQUENCY_LABELS) as AlertFrequency[]).map((f) => (
              <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
            ))}
          </Select>
        </Row>

        <Row
          checked={editCooldown} onChange={setEditCooldown}
          label="Cooldown (minutes)" id="bulk-cooldown"
        >
          <input
            type="number" min="0" value={cooldownMin}
            onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))}
            aria-label="Bulk cooldown minutes"
            disabled={!editCooldown}
            className="w-[110px] rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
          />
        </Row>

        <Row checked={editNote} onChange={setEditNote} label="Note" id="bulk-note">
          {editNote && <AlertNoteField value={note} onChange={setNote} />}
        </Row>

        <Row checked={editFilters} onChange={setEditFilters} label="Filters" id="bulk-filters">
          {editFilters && (
            <div className="space-y-2">
              <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink">
                These filters <span className="font-semibold">replace</span> whatever each
                selected alert has now — they are not added to it. An alert whose filters you
                want to keep should be left out of the selection.
                {scope.timeframes.length > 1 && (
                  <> Your selection spans {scope.timeframes.join(", ")}, so a filter left on
                  &ldquo;chart timeframe&rdquo; reads a different interval on each.</>
                )}
              </p>
              <AlertFiltersField value={filters} onChange={setFilters} />
            </div>
          )}
        </Row>

        {err && (
          <div className="space-y-1 rounded-md border border-down/40 bg-down/10 px-3 py-2">
            <p className="text-xs text-down">{err}</p>
            {rejected.length > 0 && (
              <ul className="space-y-0.5 text-[11px] text-ink-muted">
                {rejected.map((r, i) => (
                  <li key={i}>{r.symbol} ({r.kind}) — {r.reason}</li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-ink-faint">
              Nothing was changed. Every alert is checked before any of them is written.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void apply()} disabled={busy || nothingTicked}>
            {busy ? "Applying…" : `Apply to ${alerts.length}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A field that is only sent when its box is ticked. */
function Row({
  checked, onChange, label, id, children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  id: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-surface-2/40 p-2">
      <label className="flex items-center gap-2 text-sm text-ink" htmlFor={id}>
        <input
          id={id} type="checkbox" className="accent-accent"
          checked={checked} onChange={(e) => onChange(e.target.checked)}
        />
        Change {label.toLowerCase()}
      </label>
      {children && <div className="pl-6">{children}</div>}
    </div>
  );
}
