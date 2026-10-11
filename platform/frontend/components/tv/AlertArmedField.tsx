"use client";
import { Notice } from "@/components/ui";
import { ALERT_EVALUATOR_OFF_NOTICE } from "@/lib/evaluationState";
import { useAlertEvaluatorOff } from "@/lib/useEvaluationState";

/**
 * Whether the alert being created is live the moment it is saved.
 *
 * The edit dialog has always had this — `AlertEditor` calls it "Armed" — and
 * none of the four CREATE dialogs did. Every alert was born armed, so setting
 * one up in advance meant creating it live and then finding it in the panel to
 * pause it, with whatever it would have fired in between already sent.
 *
 * The capability was already there and only the dialogs were missing: the
 * create route reads `enabled` from the body and defaults it to true
 * (`platform/backend/src/api/routes/maAlerts.ts`), so this is a control over
 * something that exists rather than a switch invented in the UI.
 *
 * One component rather than four copies, for the same reason `FrequencyField`
 * is one: the word and the sentence under it have to say the same thing in
 * every dialog, and "Armed" means nothing on its own.
 *
 * C-03: and because it is in every dialog that arms an alert, it is also
 * where every one of them learns that this install does not evaluate alerts.
 * "This alert starts watching as soon as it is saved" was false there; the
 * dialog still saves (the alert runs once the evaluator is on), but it says
 * what will actually happen.
 */
export function AlertArmedField({
  value, onChange, disabledNote, evaluatorNotice = true,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  /** What this particular alert would do once armed, in its own words. */
  disabledNote?: string;
  /**
   * Whether this field carries the evaluator-off notice itself. A dialog that
   * folds the field away behind a disclosure renders `AlertEvaluatorNotice`
   * where it is always visible instead, and passes false here.
   */
  evaluatorNotice?: boolean;
}) {
  const evaluatorOff = useAlertEvaluatorOff();
  return (
    <div className="py-1">
      {evaluatorNotice && <AlertEvaluatorNotice className="mb-2" />}
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
          ? evaluatorOff
            ? "Saved armed — it starts watching once the alert evaluator is turned on."
            : disabledNote ?? "This alert starts watching as soon as it is saved."
          : "Saved paused — it watches nothing until you arm it from the Alerts panel."}
      </p>
    </div>
  );
}

/** The evaluator-off notice, for a dialog that places it itself. Renders nothing when alerts are evaluated. */
export function AlertEvaluatorNotice({ className = "" }: { className?: string }) {
  const evaluatorOff = useAlertEvaluatorOff();
  if (!evaluatorOff) return null;
  return (
    <div className={className} data-alert-evaluator-off>
      <Notice tone="warn" role="status">{ALERT_EVALUATOR_OFF_NOTICE}</Notice>
    </div>
  );
}
