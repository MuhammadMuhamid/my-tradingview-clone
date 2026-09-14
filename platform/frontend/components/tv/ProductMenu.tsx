"use client";
/**
 * The product mark, and everything the horizontal navigation bar used to be.
 *
 * ── Why the bar is gone from this workspace ────────────────────────────────
 *
 * FC2 measured it. A 40px sticky product band plus a 33px first-run band sat
 * above the chart where TradingView has nothing at all — its 38px toolbar IS
 * the top of the application — and the two of them cost 110px of chart height
 * at 1440x900, a 12.8% reduction in the product's primary working surface,
 * while chart WIDTH was already at parity. The band was also carrying a
 * duplicate: the "Trading Scene" wordmark and the "Chart" tab both resolved to
 * `/chart`, twenty pixels apart.
 *
 * A trading workstation does not spend permanent vertical budget advertising
 * its other rooms. It puts them behind the mark, which is what this is: one
 * control opening the same destinations, the same operator surfaces, the same
 * manual and the same sign-out the bar carried, plus the two live readouts
 * (`Live data`, system health) that used to sit at its right end.
 *
 * Every other route keeps the bar — a page of alerts or backtests is a page,
 * not a workstation, and there is no chart there to tax. `components/Nav`
 * renders nothing on `/chart` and this renders nowhere else, so exactly one of
 * them exists at a time and neither can drift from `lib/navigation`.
 *
 * ── TVP8 R1-02: two shapes for the trigger ─────────────────────────────────
 *
 * Measured live, TradingView's account/product entry is NOT on the toolbar at
 * all: it is a 52×38 cell at the very top-left of the window, above the left
 * rail, holding a 28px circular avatar with the user's initial and a small
 * count badge. Nothing product-branded sits on the bar, so the symbol pill is
 * the first thing there, at x=56. Ours was a glyph + chevron + separator IN
 * the row, which pushed every control after it 57px to the right.
 *
 * `variant="rail"` is that cell. `variant="bar"` is what the toolbar renders
 * today and stays byte-for-byte what it was, so the switch to the rail can
 * happen in one place (`app/chart/page.tsx`) rather than as a flag day.
 *
 * The MENU is shared, and it is the menu that changed shape for both: 40px
 * rows with a 28px glyph column and 14px/400 labels, 13px spacer separators,
 * a switch row for the theme, a key hint on the shortcuts row, and a red sign
 * out at the end — TradingView's grammar, drawn with our own glyphs and our
 * own tokens. The product name and the two status SENTENCES left the body:
 * a menu is a list of places, not a paragraph. Their truth is still here, as
 * one 32px status row at the top whose detail is in its `title`.
 */
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { HEALTH_DOT, useOpsHealth, useStreamSummary } from "@/lib/navStatus";
import { productMenuLinks, PRODUCT_NAME, SYSTEM_LINKS } from "@/lib/navigation";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import { THEME_KEY, type ThemeName } from "@/components/ThemeToggle";
import { BINDINGS, isMacPlatform } from "@/lib/shortcuts";

/** The manual. Read once, and then it stops asking. */
const HELP_HREF = "/getting-started";
const FIRST_RUN_KEY = "ts.firstRun.v1";

/**
 * Whether the manual has ever been opened.
 *
 * This is the same key the first-run band used, deliberately: a user who
 * dismissed the band before FC2R does not get asked again by its replacement.
 * The band itself is gone from the chart — an onboarding line is not worth a
 * permanent layout row on the surface people actually work on — and what
 * survives is a dot on the `Manual` entry inside this menu, which costs no
 * chart height and is still the first thing a new operator sees when they go
 * looking for where to start.
 */
function useFirstRun(): boolean {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    try { setPending(window.localStorage.getItem(FIRST_RUN_KEY) === null); }
    catch { setPending(false); }
  }, []);
  return pending;
}

function markManualSeen(): void {
  try { window.localStorage.setItem(FIRST_RUN_KEY, "1"); } catch { /* fine */ }
}

/**
 * Whether a session exists, so sign-out is offered only when it does.
 *
 * Read here rather than threaded down from the chart page: this control is the
 * only thing on the workspace that needs the answer, and a prop for it would
 * have crossed four components to arrive. TVP8 gave it a second reader — the
 * rail avatar is the user's own initial, which is the whole reason TV's entry
 * reads as an account rather than as a logo.
 */
function useUsername(): string | null {
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { authEnabled?: boolean; username?: string | null } | null) => {
        if (live && d?.authEnabled && d.username) setUsername(d.username);
      })
      .catch(() => { /* offline — hide the control */ });
    return () => { live = false; };
  }, []);
  return username;
}

/**
 * The theme, as a switch row rather than as an icon button.
 *
 * `ThemeToggle` is the same decision in the shape a control ROW cannot use: it
 * is a single button whose accessible name is the verb ("Use Light theme") and
 * whose only content is a sun or a moon. A menu row states a SETTING and shows
 * its state on the right, which is what TradingView's `Dark theme` row does
 * and what an operator reads without having to work out which way round the
 * icon means. So the row is written here and the two stay one decision by
 * sharing everything that is not presentation: `THEME_KEY`, the `data-theme`
 * and `color-scheme` contract on the root element, the `theme-color` meta, and
 * the `trading-scene-theme` event — which is also how this row stays in step
 * when `Nav`'s toggle is the one that was clicked.
 */
function useTheme(): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>("dark");

  useEffect(() => {
    const read = (): void => {
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    };
    read();
    window.addEventListener("trading-scene-theme", read);
    return () => window.removeEventListener("trading-scene-theme", read);
  }, []);

  const toggle = (): void => {
    const next: ThemeName =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage can be disabled */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", next === "dark" ? "#2e2e2e" : "#ebebeb"
    );
    window.dispatchEvent(new CustomEvent("trading-scene-theme", { detail: next }));
    setTheme(next);
  };

  return [theme, toggle];
}

/**
 * How the shortcuts sheet is opened from the keyboard, written from the table
 * that implements it.
 *
 * TradingView prints `⌘ /` on this row. Ours is `?`, and printing TV's key
 * because TV prints it would be advertising a key combination that does
 * nothing — the exact failure `ShortcutsSheet`'s own header exists to prevent.
 * The hint is therefore derived from `BINDINGS`, so it cannot drift from the
 * binding, and the modifier is the platform's own if one is ever added.
 */
function useShortcutHint(): string | null {
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(isMacPlatform()); }, []);
  const binding = BINDINGS.find((b) => b.action === "shortcuts-sheet");
  if (!binding) return null;
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(binding.key);
  return parts.join(mac ? " " : "+");
}

export interface ProductMenuProps {
  /** Height class shared with every other control on the toolbar row. Bar only. */
  buttonClass?: string;
  /**
   * `bar` is the 38px toolbar control this has always been; `rail` is the
   * 52×38 avatar cell at the top-left of the window, above the drawing rail,
   * which is where TradingView keeps the same menu (TVP8 R1-02).
   */
  variant?: "bar" | "rail";
  /**
   * Opens the keyboard-shortcuts sheet, which the chart page owns. The row is
   * rendered only when there is something to open: a menu entry that does
   * nothing is worse than no entry.
   */
  onOpenShortcuts?: () => void;
}

export function ProductMenu(
  { buttonClass = "", variant = "bar", onOpenShortcuts }: ProductMenuProps,
) {
  const path = usePathname();
  const username = useUsername();
  const [open, setOpen] = useExclusivePopover("product-menu");
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const edgeClamp = useEdgeClamp(menuRef, open);
  const health = useOpsHealth();
  const stream = useStreamSummary();
  const firstRun = useFirstRun();
  const [theme, toggleTheme] = useTheme();
  const shortcutHint = useShortcutHint();
  const rail = variant === "rail";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
    }
  };

  const signOut = async (): Promise<void> => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login";
  };

  /*
   * One badge, not two. The mark carries whichever of the two readouts is
   * actually saying something wrong — a stalled feed or an unhealthy system —
   * because a closed menu still has to be able to raise its hand. When both are
   * fine it carries nothing, which is the state it is in nearly all the time.
   */
  const streamBad = stream !== null
    && stream.state.status !== "live" && stream.state.status !== "open";
  const healthBad = health.tone !== "positive" && health.tone !== "neutral";
  const alert = streamBad ? stream.dot : healthBad ? HEALTH_DOT[health.tone] : null;

  /*
   * And one status ROW, not two sentences.
   *
   * The menu used to print the stream line and the system line as body copy
   * under the product name — three lines of prose at the top of a list of
   * places. It says the same two things in one 32px row: the worse of the two
   * readouts in a few words, and both of them in full in the tooltip. Which is
   * also why the health SENTENCE is never the label (REV-UX-01): `useOpsHealth`
   * separates the sentence from the cause, and a backend that answers an
   * operations poll with an exception puts that text in a title, not on screen.
   */
  const showHealth = streamBad ? false : healthBad || stream === null;
  const statusDot = showHealth ? HEALTH_DOT[health.tone] : stream!.dot;
  const statusLabel = showHealth
    ? (health.detail ? "System status unavailable" : `System ${health.label}`)
    : stream!.label;
  const statusDetail = [
    stream ? `${stream.label} — ${stream.detail}` : null,
    health.detail ? `${health.summary} ${health.detail}` : health.summary,
  ].filter(Boolean).join(" · ");

  const initial = (username?.trim()?.[0] ?? PRODUCT_NAME[0]!).toUpperCase();

  return (
    <div ref={boxRef} className="relative shrink-0">
      {rail ? (
        /*
          TV's cell exactly: 52 wide, 38 tall, an avatar and nothing else. No
          chevron (the avatar IS the affordance), no separator after it (the
          cell is in the rail column, not in the row), no text.
        */
        <button
          ref={buttonRef}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${PRODUCT_NAME} — go to another part of the application`}
          title={`${PRODUCT_NAME} — Screener, Trading, Alerts, Research, Operations`}
          className="tvc-control flex h-[38px] w-[52px] shrink-0 items-center justify-center text-ink"
        >
          <span className="relative inline-flex">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-state-active text-[13px] font-semibold text-ink"
            >
              {initial}
            </span>
            {(alert !== null || firstRun) && (
              <span
                aria-hidden="true"
                // accent-is-meaning: a notification dot. "Something is here",
                // not "this one is chosen". TV badges the same corner with an
                // unread count; ours carries the one readout that is unwell.
                className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${
                  alert ?? "bg-accent"
                }`}
              />
            )}
          </span>
        </button>
      ) : (
        <button
          ref={buttonRef}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${PRODUCT_NAME} — go to another part of the application`}
          title={`${PRODUCT_NAME} — Screener, Trading, Alerts, Research, Operations`}
          className={`${buttonClass} gap-1 pl-2 pr-1.5 text-ink ${
            open ? "bg-surface-2" : "hover:bg-state-hover"
          }`}
        >
          {/*
            The mark is the product's own glyph — the same frame-and-line shape
            as its installed icon — not a coloured dot. A 10px dot with a 6px
            status badge sitting half on top of it read as a rendering fault
            rather than as an icon at the size this actually ships at; a badge
            needs something big enough to be badged.
          */}
          <span className="relative inline-flex">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-accent">
              <rect x="2.5" y="3.5" width="19" height="17" rx="3" stroke="currentColor" strokeWidth="1.7" />
              <path d="M6.5 15.5l3.5-4 2.8 2.2L18 8.5" stroke="currentColor" strokeWidth="1.9"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {(alert !== null || firstRun) && (
              <span
                aria-hidden="true"
                // accent-is-meaning: a notification dot. "Something is here",
                // not "this one is chosen".
                className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-surface ${
                  alert ?? "bg-accent"
                }`}
              />
            )}
          </span>
          {/*
            The mark, not the wordmark. TradingView's product control is a logo
            glyph and a chevron and nothing else, for the same reason: the top of
            a workstation is where the instrument goes, and a product name is the
            one string on the bar that never changes and never needs reading
            twice. The name is still the accessible name of this button.
          */}
          <span className="sr-only">{PRODUCT_NAME}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="text-ink-faint">
            <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      )}

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={PRODUCT_NAME}
          onKeyDown={onMenuKeyDown}
          // Clamped for the same reason the chart-type menu is: a menu
          // anchored to a trigger is only inside the window while the trigger
          // is. See `lib/useEdgeClamp`.
          style={edgeClamp}
          // 260px and anchored at the cell's right edge in the rail, at the
          // control's bottom edge on the bar — TV's box is [53,0,260,525].
          className={`absolute z-50 w-[260px] tvc-menu ${
            rail ? "left-[52px] top-0" : "left-0 top-full"
          }`}
        >
          <div
            role="status"
            title={statusDetail}
            className="flex h-8 items-center gap-2 px-3 text-[12px] leading-none text-ink-faint"
          >
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot}`} />
            <span className="truncate">{statusLabel}</span>
          </div>

          <Spacer />

          {productMenuLinks().map(({ link }) => (
            <MenuLink key={link.href} href={link.href} path={path} onDone={() => setOpen(false)}>
              {link.label}
            </MenuLink>
          ))}

          <Spacer />

          {SYSTEM_LINKS.map((l) => (
            <MenuLink
              key={l.href}
              href={l.href}
              path={path}
              onDone={() => { if (l.href === HELP_HREF) markManualSeen(); setOpen(false); }}
              note={l.href === HELP_HREF && firstRun ? "Start here" : undefined}
            >
              {l.label}
            </MenuLink>
          ))}

          <Spacer />

          {/*
            The theme lives with the other shell controls, not floating over the
            price axis (see `ThemeToggle`) — and it states the setting rather
            than the verb, with the switch on the right where TV puts it.

            Hand-rolled rather than `.tvc-menu-row`, for one reason: that class
            paints `[aria-checked="true"]` as the inverted selection chip, which
            is right for "this is the chart type you are on" and wrong for "this
            setting is on". A switch row that fills with white when enabled
            reads as the selected ROW, not as an enabled switch. Everything else
            about the box is the row's own: the 6px gutter, the 6px radius, the
            40px minimum (given to `[role="menuitemcheckbox"]` by `globals.css`)
            and `--ts-state-hover`.
          */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={theme === "dark"}
            onClick={toggleTheme}
            className="mx-1.5 flex min-h-[40px] items-center gap-1 rounded-[var(--ts-workstation-radius)] py-0 pl-1 pr-2.5 text-left text-[14px] font-normal text-ink hover:bg-state-hover"
          >
            <Glyph>
              <path d="M20 14.2A8 8 0 019.3 3.5 8.5 8.5 0 1020 14.2z" />
            </Glyph>
            <span className="flex-1 truncate">Dark theme</span>
            <Switch on={theme === "dark"} />
          </button>

          {onOpenShortcuts && shortcutHint && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onOpenShortcuts(); }}
              className="tvc-menu-row gap-1 pl-1 pr-2.5 text-left text-[14px] font-normal text-ink"
            >
              <Glyph>
                <rect x="3" y="6" width="18" height="12" rx="2" />
                <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
              </Glyph>
              <span className="flex-1 truncate">Keyboard shortcuts</span>
              <span aria-hidden="true" className="shrink-0 text-[13px] text-ink-faint">
                {shortcutHint}
              </span>
            </button>
          )}

          {username && (
            <>
              <Spacer />
              <button
                type="button"
                role="menuitem"
                onClick={signOut}
                title={`Signed in as ${username}`}
                className="tvc-menu-row gap-1 pl-1 pr-2.5 text-left text-[14px] font-normal text-down"
              >
                <Glyph>
                  <path d="M15 17l5-5-5-5" />
                  <path d="M20 12H9" />
                  <path d="M12 4H6a2 2 0 00-2 2v12a2 2 0 002 2h6" />
                </Glyph>
                <span className="flex-1 truncate">Sign out</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The separator between sections: TV's is a 13px spacer row, which is exactly
 * what `.tvc-menu-sep` already is (a hairline with the menu's own 6px of air
 * above and below it).
 */
function Spacer() {
  return <div role="separator" className="tvc-menu-sep" />;
}

/**
 * The 28px glyph box every row carries on its left.
 *
 * Our own outline glyphs, not TradingView's (contract §8), at the optical size
 * measured on theirs. Deliberately colourless: the row owns the colour, so a
 * selected row's inverted ink and the red of `Sign out` reach the glyph
 * without either being restated here.
 */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

/** The 38×20 pill TV puts at the right of a setting row. */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-5 w-[38px] shrink-0 rounded-full transition-colors ${
        on ? "bg-ink" : "bg-state-active"
      }`}
    >
      <span
        className={`absolute top-[2px] h-4 w-4 rounded-full transition-all ${
          on ? "left-[20px] bg-popover" : "left-[2px] bg-ink-faint"
        }`}
      />
    </span>
  );
}

/**
 * One destination.
 *
 * The route the user is ON takes the menu's neutral selection chip, declared
 * through `data-active` so the painted state and the announced state are the
 * same fact — never an accent wash. There is no indentation for a section tab
 * any more: the glyph column tells nine destinations apart better than 12px of
 * left padding did, and TradingView's menu has no nesting either.
 */
function MenuLink(
  { href, path, children, onDone, note }:
  {
    href: string; path: string; children: React.ReactNode;
    onDone: () => void; note?: string;
  },
) {
  const current = path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      role="menuitem"
      aria-current={current ? "page" : undefined}
      data-active={current ? "true" : undefined}
      onClick={onDone}
      className="tvc-menu-row gap-1 pl-1 pr-2.5 text-[14px] font-normal text-ink"
    >
      <Glyph>{GLYPHS[href] ?? GLYPHS.fallback}</Glyph>
      <span className="flex-1 truncate">{children}</span>
      {/* accent-is-meaning: the note is ours — the selected row above it is the
          neutral inverted chip, which is the rule this sits next to. */}
      {note && <span className="shrink-0 text-[11px] text-accent">{note}</span>}
    </Link>
  );
}

/**
 * A glyph per destination, keyed by the route it names.
 *
 * Keyed by href rather than by label because the href is the thing
 * `lib/navigation` guarantees; a label is copy and may be rewritten. A route
 * added to `lib/navigation` without an entry here still renders — with the
 * neutral fallback — rather than a hole in the column.
 */
const GLYPHS: Record<string, React.ReactNode> = {
  // Chart: axes with a price line.
  "/chart": <><path d="M4 5v14h16" /><path d="M8 15l3.5-4 2.8 2.4L20 8" /></>,
  // Screener: a filter funnel.
  "/screener": <path d="M4 5h16l-6 7v5l-4 2v-7z" />,
  // Trading: two orders crossing.
  "/trading": <><path d="M5 8h12" /><path d="M14 5l3 3-3 3" /><path d="M19 16H7" /><path d="M10 13l-3 3 3 3" /></>,
  // Journal: a ruled notebook.
  "/journal": <><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  // Alerts: an alarm clock — not a bell, which is a notification, not a rule
  // that fires at a price (TVP8 R1-09).
  "/alerts": <><circle cx="12" cy="13.5" r="6.5" /><path d="M12 10.5v3.5l2 1.2" /><path d="M4.5 4.5L3 6" /><path d="M19.5 4.5L21 6" /></>,
  // Research: a flask — a backtest is an experiment.
  "/research": <><path d="M10 3h4" /><path d="M11 3v6l-4.7 8.8A1.5 1.5 0 007.6 20h8.8a1.5 1.5 0 001.3-2.2L13 9V3" /><path d="M8.6 14h6.8" /></>,
  // Optimizer results: parameter sliders.
  "/optimizers": <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.8" /><circle cx="15" cy="12" r="1.8" /><circle cx="10" cy="17" r="1.8" /></>,
  // Operations: stacked services.
  "/operations": <><rect x="4" y="4.5" width="16" height="6" rx="1.5" /><rect x="4" y="13.5" width="16" height="6" rx="1.5" /><path d="M7.5 7.5h.01M7.5 16.5h.01" /></>,
  // Shariah screening: a shield with a check.
  "/shariah": <><path d="M12 3l7 3v5.5c0 4-2.9 6.6-7 8.5-4.1-1.9-7-4.5-7-8.5V6z" /><path d="M9.2 12l2 2 3.6-3.8" /></>,
  // Manual: an open book.
  "/getting-started": <><path d="M12 6.5C10.6 5.1 8.6 4.5 5 4.5v13c3.6 0 5.6.6 7 2 1.4-1.4 3.4-2 7-2v-13c-3.6 0-5.6.6-7 2z" /><path d="M12 6.5v13" /></>,
  fallback: <circle cx="12" cy="12" r="7" />,
};
