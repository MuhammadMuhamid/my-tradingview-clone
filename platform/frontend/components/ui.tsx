import type { ReactNode } from "react";


export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>;
}

export function CardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {right}
    </div>
  );
}

export function Button({
  children, onClick, variant = "default", disabled, type = "button", className = "",
  label, title, pressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  /**
   * An accessible name that replaces the visible text.
   *
   * This component previously accepted no such prop, so every `aria-label` a
   * caller passed was dropped on the floor — including the one on the Alerts
   * page's bulk Delete, whose visible text is "Delete 7" and whose whole point
   * was to say WHICH seven. Measured in a browser: the rendered button had no
   * aria-label at all.
   */
  label?: string;
  title?: string;
  /** Two-state toggle, so the state is announced and not only tinted. */
  pressed?: boolean;
}) {
  const styles = {
    default: "bg-surface-2 text-ink hover:bg-border border border-border",
    primary: "bg-accent text-white hover:bg-accent/90",
    danger: "bg-down/15 text-down hover:bg-down/25 border border-down/30",
    ghost: "text-ink-muted hover:text-ink hover:bg-surface-2",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(title === undefined ? {} : { title })}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-up/15 text-up border-up/30",
    done: "bg-up/15 text-up border-up/30",
    sent: "bg-up/15 text-up border-up/30",
    running: "bg-accent/15 text-accent border-accent/30",
    queued: "bg-ink-faint/15 text-ink-muted border-border",
    pending: "bg-ink-faint/15 text-ink-muted border-border",
    requested: "bg-ink-faint/15 text-ink-muted border-border",
    submitted: "bg-accent/15 text-accent border-accent/30",
    open: "bg-accent/15 text-accent border-accent/30",
    partially_filled: "bg-warn/15 text-warn border-warn/30",
    filled: "bg-up/15 text-up border-up/30",
    canceled: "bg-ink-faint/15 text-ink-muted border-border",
    rejected: "bg-down/15 text-down border-down/30",
    paused: "bg-ink-faint/15 text-ink-muted border-border",
    stopped: "bg-ink-faint/15 text-ink-muted border-border",
    skipped: "bg-ink-faint/15 text-ink-muted border-border",
    error: "bg-down/15 text-down border-down/30",
    failed: "bg-down/15 text-down border-down/30",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${map[status] ?? map.pending}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {help && <span className="text-xs text-ink-faint">{help}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-faint">{children}</div>;
}

/**
 * A vertical hairline between groups of controls.
 *
 * The toolbars used a literal "·" character for this, which is text: it sits on
 * the baseline rather than spanning the control row, inherits whatever text
 * size is nearby, and is read out by a screen reader as a middle dot between
 * every pair of buttons.
 */
export function Separator({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-4 w-px shrink-0 bg-border ${className}`}
    />
  );
}

/**
 * An icon-only control.
 *
 * `label` is required and becomes both the accessible name and the tooltip,
 * because an icon button without one is announced as "button" and nothing
 * else — and several of these remove indicators or cancel orders.
 */
export function IconButton({
  label, onClick, children, disabled, active = false, danger = false,
  className = "", pressed,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** Currently-on, for a toggle that stays lit. */
  active?: boolean;
  danger?: boolean;
  className?: string;
  /** Set on a two-state toggle so the state is announced, not only coloured. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "text-ink-faint hover:bg-down/15 hover:text-down"
          : active
            ? "bg-surface-2 text-accent"
            : "text-ink-muted hover:bg-surface-2 hover:text-ink"
      } ${className}`}
    >
      {children}
    </button>
  );
}
