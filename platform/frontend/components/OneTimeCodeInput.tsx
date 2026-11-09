"use client";
/**
 * The one field every authenticator code is typed into (OD-2): sign-in's second
 * step, the two-factor card, the step-up dialog and account deletion.
 *
 * - `inputMode="numeric"`, `pattern="[0-9]*"`: the phone's number pad.
 * - `autoComplete="one-time-code"`: where the browser or Apple Passwords can
 *   fill the code, it offers to. Nothing here promises that it will.
 * - Six digits at most. A pasted "123 456" or "123-456" is normalised, not
 *   truncated by the browser's maxLength first (the paste is handled here).
 * - The sixth digit submits (`onComplete`), once per complete code, and Enter
 *   submits too; `enterKeyHint="done"` labels the phone's key.
 * - Always labelled.
 *
 * The code is never logged, stored or put in a URL; it lives in the parent's
 * state only until it is sent.
 */
import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { TextInput } from "@/components/ui";

export const CODE_LENGTH = 6;

/** Digits only, at most six: "123 456", "123-456" and " 123456 " all become "123456". */
export function normaliseOneTimeCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export function OneTimeCodeInput({
  id, label, value, onChange, onComplete, disabled, autoFocus, className = "", hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (code: string) => void;
  /** Called with the six digits when the sixth arrives, or on Enter with six digits. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** A short line under the field. */
  hint?: string;
}) {
  // The last complete code handed to onComplete, so a re-render cannot submit it twice.
  const submitted = useRef<string | null>(null);

  const accept = (raw: string): void => {
    const code = normaliseOneTimeCode(raw);
    onChange(code);
    if (code.length < CODE_LENGTH) { submitted.current = null; return; }
    if (submitted.current === code) return;
    submitted.current = code;
    onComplete?.(code);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (!pasted) return;
    e.preventDefault();
    accept(pasted);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = normaliseOneTimeCode(value);
    if (code.length === CODE_LENGTH) { submitted.current = code; onComplete?.(code); }
  };

  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <>
      <label className="block text-[13px] text-ink-muted" htmlFor={id}>{label}</label>
      <TextInput id={id} name="one-time-code" type="text" inputMode="numeric" pattern="[0-9]*"
        autoComplete="one-time-code" enterKeyHint="done" maxLength={CODE_LENGTH} spellCheck={false}
        autoCorrect="off" autoCapitalize="off" value={value} disabled={disabled} autoFocus={autoFocus}
        aria-describedby={hintId}
        onChange={(e) => accept(e.target.value)} onPaste={onPaste} onKeyDown={onKeyDown}
        className={`mt-1.5 block w-full max-w-[12rem] font-mono tracking-[0.2em] ${className}`} />
      {hint && <p id={hintId} className="mt-1 text-[12px] text-ink-faint">{hint}</p>}
    </>
  );
}
