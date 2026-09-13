import type { ReactNode } from "react";


/*
 * A card is a raised surface first and an outline second. The page ground is
 * `bg`, the card is `surface`, and the hairline groups rather than boxes — the
 * admin-dashboard look was every container at full border weight.
 *
 * ── Two corrections TVP7 made here ─────────────────────────────────────────
 *
 * The radius was `rounded-lg` (8px) while `Modal`'s panel is `rounded-md` (6px)
 * and the whole workstation settled on 6. The product's two primary containers
 * disagreed, in the one place a reader sees both.
 *
 * The border was `border-border/60`, and `--ts-line` is `#2e2e2e` — the exact
 * value of `--ts-bg`, the ground a card sits on. Sixty percent of an invisible
 * line is still invisible, so a page of cards had no edges at all and the
 * hierarchy was carried entirely by the fill. `--ts-line-strong` is the token
 * the workstation already uses for a line that has to be seen against the
 * ground; that is what an outer edge needs. Dividers INSIDE a card keep
 * `border-border`, where `#2e2e2e` on `#0f0f0f` reads perfectly well.
 */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-md border border-border-strong bg-surface ${className}`}>{children}</div>;
}

export function CardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {right}
    </div>
  );
}

/**
 * One page shell for every first-party route.
 *
 * Sixteen pages each retyped their own wrapper, and between them used four
 * max-widths (1400 / 1200 / 1100 / none), three gutter recipes and two vertical
 * rhythms. Three of those pages were 1100px wide underneath a 1400px
 * navigation bar, so the nav's own controls visibly overhung the content they
 * belonged to.
 *
 * `ts-app` is also what puts these pages inside the shared control-state and
 * menu grammar — see `app/globals.css`. Before it, `.tvc-control` and
 * `.tvc-menu` were scoped to the chart, so a button on Research could not hover
 * the way the same button hovers on the chart even if it asked to.
 */
export function PageShell({ children, width = "wide", className = "" }: {
  children: ReactNode;
  /** `narrow` for reading pages; `full` for the Screener's own grid. */
  width?: "wide" | "narrow" | "full";
  className?: string;
}) {
  const max = width === "full" ? "" : width === "narrow" ? "max-w-[1100px]" : "max-w-[1400px]";
  return (
    <div className={`ts-app mx-auto w-full ${max} space-y-4 px-3 py-4 sm:px-4 ${className}`}>
      {children}
    </div>
  );
}

/**
 * A page's title, its one-line explanation, and its actions.
 *
 * Seventeen `h1`s across the product used four different sizes — `text-lg`,
 * `text-base`, `text-2xl`, and on the Screener a `text-sm` heading that was
 * really a toolbar label wearing an `h1`. A reader moving between two pages
 * read two different products.
 */
export function PageHeader({ title, description, actions }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {description && (
          <p className="mt-0.5 max-w-3xl text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Anything the page needs to say about itself: an error, a caution, a note.
 *
 * There were nine distinct error treatments and four more for warnings and
 * successes — differing in radius, padding, type size, and in one case using
 * `text-ink` body copy on a red box, which is the hardest of the nine to scan.
 *
 * `tone` carries the meaning and nothing else does. The COPY is always the
 * caller's: this deliberately has no default message, because the product's
 * most valuable habit is distinguishing "we could not read this" from "you
 * have none of these", and a primitive that supplied its own words would erase
 * that distinction wherever it was adopted.
 */
export function Notice({ tone = "info", children, onDismiss, role }: {
  tone?: "error" | "warn" | "info" | "success";
  children: ReactNode;
  onDismiss?: () => void;
  role?: "alert" | "status";
}) {
  const skin = tone === "error" ? "border-down/40 bg-down/10 text-down"
    : tone === "warn" ? "border-warn/40 bg-warn/10 text-warn"
      : tone === "success" ? "border-up/40 bg-up/10 text-up"
        : "border-border-strong bg-surface-2 text-ink";
  return (
    <div role={role} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${skin}`}>
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss"
          className="tvc-control -mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
            strokeWidth="1.6" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
        </button>
      )}
    </div>
  );
}

/**
 * "Still reading this", as distinct from `Empty`'s "there is nothing here".
 *
 * Seven different loading treatments existed, two of which were `Empty` with
 * the word "Loading…" in it — which is the one thing a loading state must not
 * look like, because `Empty` is what the product says when an answer has
 * arrived and the answer is none.
 */
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p role="status" className="px-4 py-10 text-center text-sm text-ink-faint">{children}</p>
  );
}

/**
 * A backend failure, said the way a reader needs it.
 *
 * TVP8: lifted out of `app/shariah/page.tsx`, which was the one page doing
 * this correctly. `lib/api.ts` sets `Error.message` to the raw status line or
 * to whatever the backend put in its `error` field, and eight places rendered
 * that straight out as the most prominent words on the page — a URL-encoded
 * route path, a 500, or "fixture server has no route for GET /api/…" as a
 * page's headline. The contract has forbidden that on the chart for a campaign
 * and nowhere else, because the rule was scoped to the chart.
 *
 * The raw cause is kept: it is the tooltip, and it is what a support request
 * needs. It is just not the headline.
 */
export function shortReason(raw: string): string {
  if (/\b(401|403|unauthor|forbidden)/i.test(raw)) return "You may need to sign in again.";
  if (/\b(404|no route)/i.test(raw)) return "This environment does not serve it.";
  if (/\b(5\d\d|timeout|fetch failed|network)/i.test(raw)) return "The service did not answer. Try again shortly.";
  return "Hover for the reason reported.";
}

/**
 * What went wrong, in the reader's words, with the cause on hover.
 *
 * One component so that every page says it the same way and none of them has
 * to remember to pass the raw text to `title` rather than to the body.
 */
export function ErrorNotice({ error, what }: {
  /** The thrown message, as `lib/api` produced it. */
  error: string;
  /** What could not be loaded: "the screener", "this backtest". */
  what: string;
}) {
  return (
    <Notice tone="error" role="alert">
      <span title={error}>
        Could not load {what}. {shortReason(error)}
      </span>
    </Notice>
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
  /*
   * One button shape, at the control height the contract measured.
   *
   * `default` was a FILLED chip — `bg-surface-2` with an invisible
   * `border-border` outline — which is the same pre-TVP7 idiom the field
   * primitive already reversed, and at 32px it was a third height beside the
   * 34px controls in the settings dialog and the ~30px ones in the drawing
   * dialog. Three Cancel buttons in three dialogs a user opens within a minute
   * of each other is the clearest internal tell a copy can have, so there is
   * now one: an outline on a transparent ground, 34px, radius 6.
   *
   * `ghost` keeps no background of its own and takes the state chip instead of
   * a full-bleed tint.
   */
  const styles = {
    default: "border border-control-border bg-transparent text-ink tvc-control",
    primary: "bg-accent text-white hover:bg-accent/90",
    danger: "border border-down/30 bg-down/15 text-down hover:bg-down/25",
    ghost: "tvc-control text-ink-muted hover:text-ink",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(title === undefined ? {} : { title })}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={`inline-flex h-[34px] items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The close cross and the disclosure caret, drawn.
 *
 * Six controls in the chart chrome typed these instead — `×`, `▼`, and a
 * FULLWIDTH `＋` (U+FF0B), which renders at roughly double width with CJK side
 * bearings. Beside the crisp SVGs everywhere else they read as unfinished, and
 * they land off the optical centre of a 28px button because a glyph's box is
 * not its ink. The product had already written this rule down for itself in
 * two other files and then left six call sites unconverted.
 */
export function CloseGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
    </svg>
  );
}

export function CaretGlyph({ size = 8 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 8 6" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 1.5L4 4.5L7 1.5" />
    </svg>
  );
}

export function PlusGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M5 1.5v7M1.5 5h7" />
    </svg>
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

/*
 * ── A field is an OUTLINE, not a fill ──────────────────────────────────────
 *
 * These were drawn the opposite way round from every field in the workstation:
 * `border-border` — which is `--ts-line`, the same value as the page ground —
 * over a `bg-surface-2` fill. So the outline was invisible and the field was
 * identified by a lighter rectangle instead, which is a dashboard idiom and
 * reads as a chip rather than as somewhere to type.
 *
 * The workstation's dialogs settled on the measured shape: 34px tall, a 1px
 * `--ts-control-border` outline, transparent inside. One edit here reaches
 * every `TextInput` and `Select` in the product.
 *
 * `min-h` rather than `h`, because two journal fields raise themselves to 44px
 * for touch and a fixed height would fight them.
 */
/**
 * The one form-control treatment: an outline on a transparent ground.
 *
 * Exported because thirteen files had each written their own copy of the
 * string it replaced — `border border-border bg-surface-2`, an invisible
 * hairline over a lighter fill — and a primitive nobody can import is a
 * primitive that gets retyped slightly differently thirteen times.
 */
export const FIELD = "min-h-[34px] rounded-md border border-control-border bg-transparent px-2.5 "
  + "text-sm text-ink outline-none focus:border-accent";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} ${props.className ?? ""}`} />;
}

/** The same field, for prose. There was no primitive and two pages hand-rolled one. */
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${FIELD} min-h-[68px] py-1.5 ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD} ${props.className ?? ""}`} />;
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
      className={`tvc-control flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "text-ink-faint hover:bg-down/15 hover:text-down"
          : active
            ? "text-ink"
            : "text-ink-muted hover:text-ink"
      } ${className}`}
    >
      {children}
    </button>
  );
}
