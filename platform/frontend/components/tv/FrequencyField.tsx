"use client";
import { useEffect, useState } from "react";
import {
  api, isIntrabarFrequency, type AlertFrequency, type AlertFrequencyOption,
} from "@/lib/api";
import { FREQUENCY_HELP, FREQUENCY_LABELS, INTRABAR_WARNING } from "@/lib/alerts";
import type { Interval } from "@/lib/types";
import { Dropdown } from "@/components/ui";

const ORDER: AlertFrequency[] = [
  "once_per_bar_close", "once_per_bar", "once_per_minute", "once_only",
];

/**
 * The frequency selector, shared by every dialog that arms an alert.
 *
 * One component because the intrabar warning is not decoration: choosing
 * `once_per_bar` or `once_per_minute` changes what a notification MEANS, and a
 * user who picks it in one dialog and not the other must be told the same
 * thing both times.
 *
 * The wording is taken from the server when it answers, and falls back to the
 * local copy so the field is never blank while a request is in flight. Both
 * sources are pinned to the same sentence by `tests/alerts.test.ts`.
 */
export function FrequencyField({
  value, onChange, timeframe,
}: {
  value: AlertFrequency;
  onChange: (next: AlertFrequency) => void;
  /** Shown in the bar-close explanation, so "each candle" has a length. */
  timeframe: Interval;
}) {
  const [options, setOptions] = useState<AlertFrequencyOption[] | null>(null);

  useEffect(() => {
    let live = true;
    // A failure here is not worth an error message: the local copy says the
    // same thing, and the alert can still be armed.
    api.maAlertOptions()
      .then((o) => { if (live) setOptions(o.frequencies); })
      .catch(() => { /* fall back to the local wording */ });
    return () => { live = false; };
  }, []);

  const option = options?.find((o) => o.value === value) ?? null;
  const explanation = option?.explanation ?? FREQUENCY_HELP[value];
  const warning = option ? option.warning : (isIntrabarFrequency(value) ? INTRABAR_WARNING : null);

  return (
    <>
      <div className="grid grid-cols-[110px_1fr] items-center gap-3">
        {/*
          The shared Dropdown, not a native <select>: this field sits in every
          alert dialog, and contract §3 keeps the operating system's own
          control out of a dialog — it was the one OS-drawn control left in
          all of them.
        */}
        <span className="text-sm text-ink-muted" aria-hidden="true">Frequency</span>
        <Dropdown
          label="Frequency"
          width={240}
          value={value}
          onChange={(next) => onChange(next as AlertFrequency)}
          options={ORDER.map((f) => ({
            value: f,
            label: `${(options?.find((o) => o.value === f)?.label) ?? FREQUENCY_LABELS[f]}${
              f === "once_per_bar_close" ? " — default" : ""}`,
          }))}
        />
      </div>
      <p className="pl-[122px] text-xs text-ink-faint">
        {explanation}
        {value === "once_per_bar_close" && ` Candles here are ${timeframe}.`}
      </p>
      {warning && (
        // Deliberately not styled as an error: it is not a mistake to choose an
        // intrabar mode, it is a different promise, and the user has to be able
        // to read what that promise is before they accept it.
        <p
          role="note"
          className="ml-[122px] rounded-md border border-accent/30 bg-accent/10 px-2.5 py-2 text-xs text-accent"
        >
          {warning}
        </p>
      )}
    </>
  );
}
