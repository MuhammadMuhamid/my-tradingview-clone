"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, Checkbox, Dropdown, FIELD } from "@/components/ui";
import {
  AlertFiltersField, emptyFilters, filterRequestForEdit, type AlertFilterState,
} from "@/components/tv/AlertFiltersField";
import { FREQUENCY_LABELS } from "@/lib/alerts";
import { api, type AlertFrequency, type MaAlert, type MaAlertUpdate } from "@/lib/api";
import { describeAction, said, type FailureCopy } from "@/lib/errorCopy";

/**
 * Give many alerts the same setting in one save.
 *
 * ── Why every field is opt-in ─────────────────────────────────────────────
 *
 * The dialog sends ONLY the fields whose checkbox is on. A form pre-filled
 * from "the first selected alert" and sent whole would quietly push that
 * alert's cadence and gates onto every other one — the user asked to change
 * the cooldown, not to make twenty alerts identical to one of them.
 *
 * Nothing here is pre-filled for the same reason: there is no honest value to
 * show for a selection whose alerts disagree, and showing one of them invites
 * exactly the accident above.
 *
 * ── Gates replace, and the dialog says so ─────────────────────────────────
 *
 * There is no "add this gate to what each alert already has": that cannot be
 * shown honestly for a selection whose alerts carry different gates, so the
 * server replaces the list outright and this dialog states it in words rather
 * than leaving the user to discover it.
 *
 * The server plans every row before writing any, so a refusal here leaves all
 * of them untouched — which is why the error is shown and the dialog stays
 * open rather than closing on a partial result.
 */
/**
 * A ticked setting, with its name where the reader can see it.
 *
 * `Checkbox` carries `label` as the ACCESSIBLE name only — an 18px box and
 * nothing else — and every other dialog in the product pairs it with a visible
 * span. This one did not, so it rendered four naked boxes: a bare dropdown, a
 * bare `60` with no unit, a bare text field and a sentence used as a button
 * label. The same pattern as `ChartSettingsModal` and `DrawingSettingsModal`.
 */
function TickedSetting({ checked, onChange, label, children }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
        <Checkbox checked={checked} onChange={onChange} label={label} />
        <span>{label}</span>
      </label>
      {checked && <div className="pl-6">{children}</div>}
    </div>
  );
}

export function BulkEditAlertsModal({
  alerts, open, onClose, onSaved,
}: {
  alerts: MaAlert[];
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [useFrequency, setUseFrequency] = useState(false);
  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [useCooldown, setUseCooldown] = useState(false);
  const [cooldownMin, setCooldownMin] = useState(60);
  const [useNote, setUseNote] = useState(false);
  const [note, setNote] = useState("");
  const [useGates, setUseGates] = useState(false);
  const [gates, setGates] = useState<AlertFilterState>(emptyFilters);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);

  // Reopening must not inherit the last edit's choices: the selection is
  // usually different, and a remembered "replace the gates" tick is a
  // destructive default nobody asked for twice.
  useEffect(() => {
    if (!open) return;
    setUseFrequency(false); setUseCooldown(false); setUseNote(false); setUseGates(false);
    setFrequency("once_per_bar_close"); setCooldownMin(60); setNote("");
    setGates(emptyFilters());
    setErr(null);
  }, [open]);

  const kinds = new Set(alerts.map((a) => a.conditionKind));
  const nothingChosen = !useFrequency && !useCooldown && !useNote && !useGates;

  const save = async () => {
    if (nothingChosen) { setErr(said("Tick at least one setting to change.")); return; }
    setBusy(true);
    setErr(null);
    try {
      const patch: MaAlertUpdate = {
        ...(useFrequency ? { frequency } : {}),
        ...(useCooldown ? { cooldownMin } : {}),
        ...(useNote ? { note: note.trim() || null } : {}),
        ...(useGates ? filterRequestForEdit(gates) : {}),
      };
      const result = await api.bulkEditMaAlerts(alerts.map((a) => a.id), patch);
      onSaved(
        `${result.updated.length} alert${result.updated.length === 1 ? "" : "s"} updated`
      );
      onClose();
    } catch (e) {
      setErr(describeAction(e, "update the selected alerts"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit ${alerts.length} alert${alerts.length === 1 ? "" : "s"}`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || nothingChosen}>
            {busy ? "Saving…" : "Apply to selected"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-muted">
          Only the settings you tick are changed. Everything else on each alert
          is left exactly as it is.
          {kinds.size > 1 && (
            <> The selection spans {kinds.size} alert types, so only settings
            common to all of them can be changed here.</>
          )}
        </p>

        <TickedSetting checked={useFrequency} onChange={setUseFrequency} label="How often it may notify">
          <Dropdown
            value={frequency}
            label="Bulk frequency"
            width={180}
            options={(Object.keys(FREQUENCY_LABELS) as AlertFrequency[])
              .map((f) => ({ value: f, label: FREQUENCY_LABELS[f] }))}
            onChange={(next) => setFrequency(next as AlertFrequency)}
          />
        </TickedSetting>

        <TickedSetting checked={useCooldown} onChange={setUseCooldown} label="Cooldown (minutes)">
          <input
            type="number" min="0" value={cooldownMin} aria-label="Bulk cooldown minutes"
            onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))}
            className={`${FIELD} w-[110px]`}
          />
        </TickedSetting>

        <TickedSetting checked={useNote} onChange={setUseNote} label="Note">
          <input
            type="text" value={note} aria-label="Bulk note"
            placeholder="Leave empty to clear the note"
            onChange={(e) => setNote(e.target.value)}
            className={`${FIELD} w-full`}
          />
        </TickedSetting>

        <TickedSetting
          checked={useGates} onChange={setUseGates}
          label="Conditions (replaces the conditions on every selected alert)"
        >
            <div className="flex flex-col gap-2">
              <AlertFiltersField value={gates} onChange={setGates} />
              <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
                These conditions REPLACE whatever each selected alert carries
                now — they are not added to them. Leaving the list empty removes
                the conditions from every selected alert.
              </p>
            </div>
        </TickedSetting>

        {/*
          * The headline is the page copy; the provider's own words stay in the
          * diagnostic channel, where they are available without being quoted
          * at the reader.
          */}
        {err && (
          <p className="text-sm text-down" role="alert" title={err.detail || undefined}>
            {err.headline}
          </p>
        )}
      </div>
    </Modal>
  );
}
