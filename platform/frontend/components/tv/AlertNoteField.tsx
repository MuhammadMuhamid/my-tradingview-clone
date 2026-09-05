"use client";
import { NOTE_MAX_LENGTH } from "@/lib/api";

/**
 * The user's own reason for arming an alert.
 *
 * It rides along in the push notification, after the market fact. That ordering
 * is the whole design: weeks later a phone buzzing with "price reached 2.226"
 * says what happened but not why you cared, and "TP1 for the March long" says
 * why you cared but not whether to act. The notification carries both, in that
 * order, because notification bodies truncate from the end.
 *
 * Bounded at the same length the server and the schema enforce, and counted
 * down here so the limit is met while typing rather than as a 400 on save.
 */
export function AlertNoteField({
  value, onChange, placeholder = "Why this alert? e.g. TP1 · stop loss · watching for the retest",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const remaining = NOTE_MAX_LENGTH - value.length;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-muted">Message</span>
        {/* Only once it is worth knowing. A counter on an empty field is noise;
            one at 40 characters left is the warning that matters. */}
        {remaining <= 40 && (
          <span className={`text-[11px] ${remaining < 0 ? "text-down" : "text-ink-faint"}`}>
            {remaining} left
          </span>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={NOTE_MAX_LENGTH}
        rows={2}
        aria-label="Alert note"
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <p className="text-xs text-ink-faint">
        Optional. Shown at the end of the notification, so you know why you set it.
      </p>
    </div>
  );
}
