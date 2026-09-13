"use client";

/**
 * Whether the alert being created is live the moment it is saved.
 *
 * The edit dialog has always had this — `AlertEditor` calls it "Armed" — and
 * none of the five CREATE dialogs did. Every alert was born armed, so setting
 * one up in advance meant creating it live and then finding it in the panel to
 * pause it, with whatever it would have fired in between already sent.
 *
 * The capability was already there and only the dialogs were missing: the
 * create route reads `enabled` from the body and defaults it to true
 * (`platform/backend/src/api/routes/maAlerts.ts`), so this is a control over
 * something that exists rather than a switch invented in the UI.
 *
 * One component rather than five copies, for the same reason `FrequencyField`
 * is one: the word and the sentence under it have to say the same thing in
 * every dialog, and "Armed" means nothing on its own.
 */
export function AlertArmedField({
  value, onChange, disabledNote,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  /** What this particular alert would do once armed, in its own words. */
  disabledNote?: string;
}) {
  return (
    <div className="py-1">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={value}
          className="accent-accent"
          onChange={(event) => onChange(event.target.checked)}
        />
        Armed
      </label>
      {/*
        State is never signalled by a checkbox alone: the sentence says which
        of the two things is about to happen, in both directions. A user who
        unticks this is deliberately setting something up for later and should
        be told it will sit there until they arm it.
      */}
      <p className="mt-0.5 text-xs text-ink-faint">
        {value
          ? disabledNote ?? "This alert starts watching as soon as it is saved."
          : "Saved paused — it watches nothing until you arm it from the Alerts panel."}
      </p>
    </div>
  );
}
