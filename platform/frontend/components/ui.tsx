"use client";
/*
 * ── Why this file is a client module now (TVP8 / R6) ───────────────────────
 *
 * The chart-settings dialog's row grammar — checkbox, dropdown, colour swatch,
 * line-style button, number field — is the product's grammar, not that
 * dialog's: contract §7 says the unique pages share the primitives in this
 * file, and a second copy living under `components/tv` would be the "thirteen
 * files retyped the string" failure this file exists to prevent. Those five
 * hold state (a popover is open, a menu row is focused), so the module they
 * live in is a client module.
 *
 * The two server components that import from here — `app/getting-started` and
 * `app/journal/loading` — take `PageShell` / `PageHeader` with children and no
 * function props, which a server component renders through a client boundary
 * unchanged.
 */
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import { useExclusivePopover } from "@/lib/useExclusivePopover";


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
export function PageShell({
  children, width = "wide", className = "", role, "aria-label": ariaLabel,
}: {
  children: ReactNode;
  /** `narrow` for reading pages; `full` for the Screener's own grid. */
  width?: "wide" | "narrow" | "full";
  className?: string;
  /*
   * TVP8 round two. Six pages hand-rolled this component's exact markup —
   * `ts-app mx-auto w-full max-w-[1400px] space-y-4 px-3 py-4 sm:px-4`, letter
   * for letter — while five used the component, so the product had one page
   * shell with two implementations and `PageShell` had a single caller's worth
   * of authority over a measurement eleven pages depend on.
   *
   * `journal/loading.tsx` was one of them and could not have used it: a
   * loading shell announces itself, and there was no way to put `role` and a
   * label on the element. That is the whole reason these two exist here, and
   * the reason they are named rather than spread — a shell that accepts
   * arbitrary props is a `<div>` with extra steps.
   */
  role?: string;
  "aria-label"?: string;
}) {
  const max = width === "full" ? "" : width === "narrow" ? "max-w-[1100px]" : "max-w-[1400px]";
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={`ts-app mx-auto w-full ${max} space-y-4 px-3 py-4 sm:px-4 ${className}`}
    >
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
export function PageHeader({ title, description, actions, leading }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * Rendered before the title, on the same line.
   *
   * TVP8 round two: a DETAIL page puts a back link there — "← Backtests" then
   * the backtest's name — and having nowhere to put it was the reason the
   * research detail page drew its own heading instead of using this. A slot
   * is cheaper than an exemption, and an exemption nobody wrote down is a gap.
   */
  leading?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="min-w-0">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {description && (
          <p className="mt-0.5 max-w-3xl text-sm text-ink-muted">{description}</p>
        )}
        </div>
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
 *
 * ── REV-UX-01: this is a RE-EXPORT now, and was not before ─────────────────
 *
 * `lib/errorCopy.ts` says in its own docstring that "`ui.tsx` re-exports it.
 * One implementation, reachable from both sides." That was the intent and it
 * was not what the code did: this file carried a second, independent copy of
 * the four branches, so the rule had two implementations that could drift and
 * one of them was invisible to anyone reading the other. They had not drifted
 * yet. Re-exporting is what the comment always claimed.
 */
export { shortReason } from "@/lib/errorCopy";
import { shortReason } from "@/lib/errorCopy";

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
  /**
   * `contrast` is a DIALOG's confirming action — R6 CH-4.
   *
   * Measured on the reference's settings footer, `Ok` is a light-filled chip
   * with dark text (rgb 242,242,242), the same inversion the selected menu row
   * uses, and `Cancel` beside it carries no border at all. Ours were an
   * accent-blue `Ok` and an outlined `Cancel`, which is the one place in the
   * product where accent reads as "the safe one" rather than as meaning.
   *
   * A variant rather than a re-tokened `primary`: `primary` is the page-level
   * call to action (Save, Run, Deploy) and re-colouring it would repaint forty
   * buttons to fix two.
   */
  variant?: "default" | "primary" | "contrast" | "danger" | "ghost";
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
    // The inverted chip the selected menu row already uses: light on dark,
    // dark on light, one token pair, no second definition of "contrast".
    contrast: "bg-[var(--ts-menu-selected-bg)] text-[var(--ts-menu-selected-ink)] hover:opacity-90",
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

/* ══════════════════════════════════════════════════════════════════════════
 * The settings-row grammar (TVP8 / R6)
 *
 * Five primitives, measured off the reference's chart-settings dialog at
 * 1440×900 dark, and one reason they live in this file rather than beside the
 * dialog that needed them first: contract §7 — the unique pages use the SAME
 * primitives as the workstation. A colour swatch written under `components/tv`
 * is a colour swatch the Screener cannot have.
 *
 * What they replace: a native `<input type="checkbox" class="accent-accent">`,
 * five native `<select>`s (whose OS popup and OS chevron are the most visible
 * "different product" tell a dialog can have), a native `<input type="color">`
 * at 34×26, and a line that was a swatch plus a number plus a select laid out
 * inline, three controls wide, in a row the reference draws as one button.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The palette every colour control in the product opens.
 *
 * Two rows of nine: the reference's neutral ramp from white to black, then the
 * chromatic row. `""` — "the theme's own" — is not in here; it is the popover's
 * first cell, because it is a different KIND of answer from a colour.
 */
export const SWATCH_PALETTE: readonly string[] = [
  "#ffffff", "#d1d4dc", "#9598a1", "#787b86", "#5d606b", "#434651", "#2a2e39", "#131722", "#000000",
  "#f6465d", "#ff9800", "#ffeb3b", "#2ebd85", "#089981", "#2962ff", "#7e57c2", "#e91e63", "#795548",
];

/**
 * A popover anchored under a control, positioned in VIEWPORT coordinates.
 *
 * `position: fixed`, not `absolute`, and that is the whole reason this helper
 * exists: the settings dialog's tab panel is the scroller (`overflow-y: auto`),
 * and an absolutely-positioned popover inside a scroll container is CLIPPED by
 * it — a palette opened from the last row of the Canvas tab would have been
 * cut in half. Fixed coordinates are computed from the trigger's own rect when
 * the popover opens, and flipped above the trigger when there is no room below.
 */
function useAnchor(open: boolean, trigger: RefObject<HTMLElement>, box: RefObject<HTMLElement>): {
  left: number; top: number;
} {
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const t = trigger.current?.getBoundingClientRect();
    if (!t) return;
    const height = box.current?.offsetHeight ?? 0;
    const width = box.current?.offsetWidth ?? 0;
    const below = t.bottom + 4;
    const top = height > 0 && below + height > window.innerHeight - 8
      ? Math.max(8, t.top - 4 - height)
      : below;
    const left = width > 0
      ? Math.max(8, Math.min(t.left, window.innerWidth - 8 - width))
      : t.left;
    setPos({ left, top });
  }, [open, trigger, box]);
  return pos;
}

/** Outside-click and Escape, the two ways every popover in the product closes. */
function useDismiss(
  open: boolean, onClose: () => void,
  ...within: RefObject<HTMLElement>[]
): void {
  const refs = useRef(within);
  refs.current = within;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (refs.current.some((r) => r.current?.contains(target))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // The dialog behind this one must not close as well: a popover is the
      // innermost thing on screen and Escape belongs to it first.
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);
}

/**
 * A checkbox at the size and weight the reference draws one.
 *
 * 18px, radius 3, and CHECKED is the contrast fill — light ground, dark tick,
 * the same inversion as `Button variant="contrast"` and the selected menu row.
 * It was `accent-accent`: the browser's own box tinted product blue, which is
 * both the wrong shape and the one use of accent the contract forbids.
 *
 * A real `<input type="checkbox">` under the paint, so it is announced,
 * focusable, and `checked` is readable by a test rather than inferred.
 */
export function Checkbox({ checked, onChange, label, disabled = false, id }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name. Required: an unlabelled box says only "checkbox". */
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
        className="peer h-[18px] w-[18px] shrink-0 cursor-pointer appearance-none rounded-[3px]
          border border-control-border bg-transparent
          checked:border-transparent checked:bg-[var(--ts-menu-selected-bg)]
          disabled:cursor-not-allowed disabled:opacity-40"
      />
      <svg
        width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"
        className="pointer-events-none absolute hidden peer-checked:block"
        stroke="var(--ts-menu-selected-ink)" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
      >
        <path d="M2 6.2l2.8 2.8L10 3.6" />
      </svg>
    </span>
  );
}

/**
 * A list of choices, drawn by this product rather than by the operating system.
 *
 * A native `<select>` renders the OS's own chevron and opens the OS's own
 * popup — a different font, a different row height, a different selection
 * colour, and on macOS a list that overlays the trigger. Five of them in one
 * dialog is the single loudest "this is not that product" signal in a
 * screenshot. This is a 34px `.tvc-control` button that opens the `.tvc-menu`
 * every other menu in the workstation uses.
 *
 * B-27: at the DROPDOWN row, 40px. It opened the 32px context-menu row
 * (`.tvc-menu--compact`), and the contract's density table is explicit that
 * a dropdown row is 40 and only a context menu is the denser 32.
 *
 * `role="listbox"` / `role="option"`, not `menu`/`menuitem`: it has a VALUE.
 */
export function Dropdown({
  value, onChange, options, label, width = 150, disabled = false, id,
}: {
  value: string;
  onChange: (next: string) => void;
  options: readonly { value: string; label: string }[];
  /** The accessible name — the row's own label, e.g. "Precision". */
  label: string;
  /** 100 / 150 / 180, per the row's measured width in the reference. */
  width?: number;
  disabled?: boolean;
  /**
   * This popover's name in the registry (`lib/popoverGroup`), so only one
   * popover in the product is open at a time. Defaults to the accessible name,
   * which is already unique within a dialog; pass one explicitly where two
   * instances could share a label.
   */
  id?: string;
}) {
  const popoverId = id ?? label;
  const [open, setOpen] = useExclusivePopover(`ui-dropdown:${popoverId}`);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    boxRef.current?.querySelector("button")?.focus();
  }, [setOpen]);
  useDismiss(open, close, boxRef, menuRef);
  const pos = useAnchor(open, boxRef, menuRef);
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    (items.find((el) => el.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
        style={{ width }}
        className="tvc-control flex h-[34px] items-center justify-between gap-1.5 rounded-md
          border border-control-border bg-transparent px-2.5 text-sm text-ink
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <CaretGlyph size={10} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: width, zIndex: 60 }}
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
            }
          }}
          className="tvc-menu"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => { onChange(o.value); close(); }}
              className="tvc-menu-row px-2.5 text-left text-sm text-ink"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The palette grid both colour controls open, and the `Custom…` escape hatch. */
function Palette({ value, onChange, allowTheme, onDone }: {
  value: string;
  onChange: (next: string) => void;
  /** Whether `""` — "follow the theme" — is a legal answer for this setting. */
  allowTheme: boolean;
  onDone: () => void;
}) {
  return (
    <div className="p-1.5">
      <div className="grid grid-cols-9 gap-1">
        {allowTheme && (
          <button
            type="button"
            aria-label="Theme colour"
            title="Follow the active theme"
            onClick={() => { onChange(""); onDone(); }}
            className="tvc-control relative h-5 w-5 rounded-sm border border-control-border"
          >
            <svg viewBox="0 0 20 20" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <path d="M2 18L18 2" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        )}
        {SWATCH_PALETTE.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={hex}
            title={hex}
            onClick={() => { onChange(hex); onDone(); }}
            style={{ backgroundColor: hex }}
            className={`h-5 w-5 rounded-sm border ${
              hex === value ? "border-ink" : "border-black/20"
            }`}
          />
        ))}
      </div>
      {/*
        The native picker, kept reachable rather than replaced.
        A palette of eighteen is what a trader uses; the OS picker is what they
        need on the day none of the eighteen is their firm's red. The input
        carries the label's click and the keyboard's focus, so this is a
        control and not a decoration.
      */}
      <label className="tvc-control mt-1.5 flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-ink-muted hover:text-ink">
        <span
          className="h-4 w-4 rounded-sm border border-control-border"
          style={{ backgroundColor: value || "transparent" }}
        />
        Custom…
        <input
          type="color"
          value={value || "#ffffff"}
          aria-label="Custom colour"
          onChange={(e) => onChange(e.target.value)}
          className="h-0 w-0 opacity-0"
        />
      </label>
    </div>
  );
}

/**
 * A colour, as a 34×34 well with a 24px centre — the reference's own geometry.
 *
 * It was a bare `<input type="color">` at 34×26: the browser's well, the
 * browser's border radius, and no way to say "follow the theme" except a
 * separate 26px button that appeared beside it when a colour was pinned.
 * `Theme` is the first cell of the palette now, so `""` is reachable from the
 * same place every other answer is.
 */
export function Swatch({
  value, onChange, label, allowTheme = false, disabled = false, id, effectiveColor,
}: {
  /** A `#rrggbb` literal, or `""` for "the theme's own" when `allowTheme`. */
  value: string;
  onChange: (next: string) => void;
  label: string;
  allowTheme?: boolean;
  disabled?: boolean;
  /** See `Dropdown.id` — the registry name for this popover. */
  id?: string;
  /** Concrete/token colour currently supplied by the theme when value is empty. */
  effectiveColor?: string;
}) {
  const popoverId = id ?? label;
  const [open, setOpen] = useExclusivePopover(`ui-swatch:${popoverId}`);
  const boxRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(open, close, boxRef, popRef);
  const pos = useAnchor(open, boxRef, popRef);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value || effectiveColor || "Theme colour"}
        onClick={() => setOpen(!open)}
        className="tvc-control flex h-[34px] w-[34px] items-center justify-center rounded-md
          border border-control-border disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span
          className="h-6 w-6 rounded-[3px] border border-black/20"
          style={{ backgroundColor: value || effectiveColor || "var(--ts-surface-2)" }}
        >
          {value === "" && !effectiveColor && (
            <svg viewBox="0 0 24 24" className="h-full w-full text-ink-faint" aria-hidden="true">
              <path d="M3 21L21 3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>
      </button>
      {open && (
        <div
          ref={popRef}
          style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60 }}
          className="tvc-popover"
        >
          <Palette value={value} onChange={onChange} allowTheme={allowTheme} onDone={close} />
        </div>
      )}
    </div>
  );
}

/** The three dash patterns, as an SVG dash array at a given width. */
function dashArray(style: "solid" | "dotted" | "dashed", width: number): string | undefined {
  if (style === "solid") return undefined;
  return style === "dotted" ? `${width} ${width * 2}` : `${width * 4} ${width * 2}`;
}

/**
 * Colour, width and dash pattern behind ONE 75×34 button.
 *
 * The reference uses this row shape five times on Scales and three times on
 * Canvas; this product had the same three settings laid out inline — a swatch,
 * a 56px number and a 104px select — so a row that is one control there was
 * three here, and they mounted and unmounted as their checkbox was toggled,
 * which made the row jump.
 *
 * The button shows what it will draw: the colour square, then a preview line in
 * the current width and pattern.
 */
export function LineStyleButton({
  color, width, style, onChange, label, allowTheme = false, disabled = false, id,
  effectiveColor,
}: {
  color: string;
  width: number;
  style: "solid" | "dotted" | "dashed";
  onChange: (next: { color: string; width: number; style: "solid" | "dotted" | "dashed" }) => void;
  label: string;
  allowTheme?: boolean;
  disabled?: boolean;
  /** See `Dropdown.id` — the registry name for this popover. */
  id?: string;
  /** Concrete/token colour currently supplied by the theme when color is empty. */
  effectiveColor?: string;
}) {
  const popoverId = id ?? label;
  const [open, setOpen] = useExclusivePopover(`ui-line-style:${popoverId}`);
  const boxRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(open, close, boxRef, popRef);
  const pos = useAnchor(open, boxRef, popRef);
  const stroke = color || effectiveColor || "currentColor";

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="tvc-control flex h-[34px] w-[75px] items-center justify-center rounded-md
          border border-control-border text-ink
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg width="40" height="12" viewBox="0 0 40 12" className="shrink-0" aria-hidden="true">
          <path
            d="M0 6h40" stroke={stroke} strokeWidth={Math.max(2, width)}
            strokeDasharray={dashArray(style, Math.max(2, width))} strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60 }}
          className="tvc-popover w-[228px]"
        >
          <Palette
            value={color}
            onChange={(next) => onChange({ color: next, width, style })}
            allowTheme={allowTheme}
            onDone={close}
          />
          <WidthPicker value={width} onChange={(w) => onChange({ color, width: w, style })} />
          <DashPicker value={style} width={width} onChange={(s) => onChange({ color, width, style: s })} />
        </div>
      )}
    </div>
  );
}

/**
 * The line-width row of `LineStyleButton`'s popover, on its own.
 *
 * Exported so a surface that offers width as its OWN control — the selected
 * drawing's floating toolbar (B-11) — opens these same four buttons rather
 * than a second picker that would drift from this one.
 */
export function WidthPicker({ value, onChange }: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-1.5 pb-1.5 first:pt-1.5">
      {[1, 2, 3, 4].map((w) => (
        <button
          key={w}
          type="button"
          aria-label={`Width ${w}`}
          aria-pressed={w === value}
          onClick={() => onChange(w)}
          className="tvc-control flex h-8 min-w-[44px] flex-1 items-center justify-center rounded-md text-ink"
        >
          <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
            <path d="M0 6h22" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
          </svg>
        </button>
      ))}
    </div>
  );
}

/** The dash-pattern row of `LineStyleButton`'s popover, on its own (see `WidthPicker`). */
export function DashPicker({ value, width, onChange }: {
  value: "solid" | "dotted" | "dashed";
  width: number;
  onChange: (next: "solid" | "dotted" | "dashed") => void;
}) {
  return (
    <div className="flex items-center gap-1 px-1.5 pb-1.5 first:pt-1.5">
      {(["solid", "dotted", "dashed"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-label={s[0]!.toUpperCase() + s.slice(1)}
          aria-pressed={s === value}
          onClick={() => onChange(s)}
          className="tvc-control flex h-8 min-w-[60px] flex-1 items-center justify-center rounded-md text-ink"
        >
          <svg width="42" height="12" viewBox="0 0 42 12" aria-hidden="true">
            <path
              d="M0 6h42" stroke="currentColor" strokeWidth={width}
              strokeDasharray={dashArray(s, width)} strokeLinecap="round"
            />
          </svg>
        </button>
      ))}
    </div>
  );
}

/** The colour grid `Swatch` and `LineStyleButton` open, for a surface with its own trigger. */
export function ColourPalette(props: {
  value: string;
  onChange: (next: string) => void;
  onDone: () => void;
}) {
  return <Palette {...props} allowTheme={false} />;
}

/**
 * A trigger that opens one of the pickers above, for a surface whose buttons
 * are not dialog form controls — the selected drawing's floating toolbar.
 *
 * The popover machinery is the dialog's own — `useExclusivePopover`, so one
 * popover is open at a time; `useDismiss`, so outside-click and Escape close
 * it; `useAnchor`, so it is placed in viewport coordinates and flips above the
 * trigger near the bottom of the screen. Only the trigger's shape is the
 * caller's, because a toolbar button is 38px and borderless where a dialog's
 * is 34px and outlined.
 */
export function PopoverButton({ label, title, className, children, popover, id, popoverClassName = "" }: {
  label: string;
  title?: string;
  className: string;
  children: ReactNode;
  /** The popover's body; `close` dismisses it, for a pick that is final. */
  popover: (close: () => void) => ReactNode;
  /** See `Dropdown.id`. */
  id?: string;
  popoverClassName?: string;
}) {
  const [open, setOpen] = useExclusivePopover(`ui-popover-button:${id ?? label}`);
  const boxRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(open, close, boxRef, popRef);
  const pos = useAnchor(open, boxRef, popRef);
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-label={label}
        title={title ?? label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={className}
      >
        {children}
      </button>
      {open && (
        <div
          ref={popRef}
          style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60 }}
          className={`tvc-popover ${popoverClassName}`}
        >
          {popover(close)}
        </div>
      )}
    </div>
  );
}

/**
 * A number, at the size the reference's settings dialog draws one.
 *
 * 70×28 with the unit as plain 14px muted text AFTER the field — not a suffix
 * inside it, and not a 34px control: the reference's number fields are the one
 * thing in that dialog shorter than its buttons, which is why `%` and `bars`
 * read as words rather than as part of the box.
 */
export function NumberField({
  value, onChange, min, max, step = 1, label, unit, width = 70, disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  /** `%`, `bars`, `min` — rendered beside the field, never inside it. */
  unit?: string;
  width?: number;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        style={{ width }}
        className="tabular h-[28px] rounded-md border border-control-border bg-transparent px-2
          text-right text-sm text-ink outline-none focus:border-accent
          disabled:cursor-not-allowed disabled:opacity-40"
      />
      {unit && <span className="text-sm text-ink-faint">{unit}</span>}
    </span>
  );
}

/**
 * The workstation's own tooltip.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Measured across the chrome: 38 of 65 buttons carried a native `title` and 27
 * carried nothing, so hovering a control either produced the OPERATING
 * SYSTEM's bubble — its font, its delay, its corner, its shadow — or produced
 * silence. The reference draws its own chip on every control and sets
 * `title=null`, and an OS bubble in the middle of a workstation is an instant
 * "this is a web page". Several of the `title` strings here are word-for-word
 * the reference's tooltip copy, so the intent was always to match; only the
 * mechanism was wrong.
 *
 * ── Why one listener rather than a chip per control ───────────────────────
 *
 * The drawing rail already draws a correct chip, as a sibling span revealed by
 * `peer-hover`. That works there because a rail cell is a fixed 52px box with
 * room beside it. A toolbar button is 38px in a `flex-nowrap` row, and 38
 * copies of an absolutely-positioned span inside it is 38 chances to clip one
 * against a scroll container. This renders ONE element at the document level
 * and moves it, which also means a control opts in by naming itself
 * (`data-tooltip`) rather than by being wrapped.
 *
 * Geometry is the reference's, measured 2026-09-18: 24px tall, 13px text,
 * `--ts-tooltip-bg`, radius 2, padding 3px 8px, 4px below the control.
 */
export function ChromeTooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
    const hide = () => { clear(); setTip(null); };

    const over = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest?.("[data-tooltip]");
      if (!(target instanceof HTMLElement)) { hide(); return; }
      const text = target.getAttribute("data-tooltip");
      if (!text) { hide(); return; }
      // A disabled control still explains itself — that is usually when the
      // reader most wants to know what it is.
      clear();
      timer.current = setTimeout(() => {
        const box = target.getBoundingClientRect();
        setTip({ text, x: Math.round(box.left + box.width / 2), y: Math.round(box.bottom + 4) });
      }, 260);
    };

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerdown", hide, true);
    // A control that scrolls or unmounts under the pointer must not leave its
    // chip behind.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clear();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      role="tooltip"
      data-chrome-tooltip="true"
      style={{
        position: "fixed", left: tip.x, top: tip.y,
        transform: "translateX(-50%)",
        backgroundColor: "var(--ts-tooltip-bg)",
      }}
      className="pointer-events-none z-[200] flex h-[24px] max-w-[320px] items-center
        overflow-hidden whitespace-nowrap rounded-[2px] px-2 text-[13px] leading-none text-white"
    >
      {tip.text}
    </div>
  );
}
