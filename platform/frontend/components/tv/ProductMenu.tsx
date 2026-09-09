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
 * 38px control at the left of the chart toolbar, opening the same five
 * destinations, the same operator surfaces, the same manual and the same
 * sign-out the bar carried, plus the two live readouts (`Live data`, system
 * health) that used to sit at its right end.
 *
 * Every other route keeps the bar — a page of alerts or backtests is a page,
 * not a workstation, and there is no chart there to tax. `components/Nav`
 * renders nothing on `/chart` and this renders nowhere else, so exactly one of
 * them exists at a time and neither can drift from `lib/navigation`.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { HEALTH_DOT, useOpsHealth, useStreamSummary } from "@/lib/navStatus";
import { productMenuLinks, PRODUCT_NAME, SYSTEM_LINKS } from "@/lib/navigation";

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
 * have crossed four components to arrive.
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

export interface ProductMenuProps {
  /** Height class shared with every other control on the toolbar row. */
  buttonClass: string;
}

export function ProductMenu({ buttonClass }: ProductMenuProps) {
  const path = usePathname();
  const username = useUsername();
  const [open, setOpen] = useExclusivePopover("product-menu");
  const boxRef = useRef<HTMLDivElement>(null);
  const health = useOpsHealth();
  const stream = useStreamSummary();
  const firstRun = useFirstRun();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

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
  const alert = stream && stream.state.status !== "live" && stream.state.status !== "open"
    ? stream.dot
    : health.tone === "positive" || health.tone === "neutral" ? null : HEALTH_DOT[health.tone];

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${PRODUCT_NAME} — go to another part of the application`}
        title={`${PRODUCT_NAME} — Screener, Trading, Alerts, Research, Operations`}
        className={`${buttonClass} gap-1 pl-2 pr-1.5 text-ink ${
          open ? "bg-surface-2" : "hover:bg-surface-2"
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
          twice. The name is still the menu's first line, and still the
          accessible name of this button.
        */}
        <span className="sr-only">{PRODUCT_NAME}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="text-ink-faint">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={PRODUCT_NAME}
          className="absolute left-0 top-full z-50 w-72 border border-border bg-surface py-1 shadow-2xl"
        >
          <div className="px-3 pb-1.5 pt-1.5">
            <div className="text-sm font-semibold text-ink">{PRODUCT_NAME}</div>
            <div className="mt-1 flex flex-col gap-0.5 text-[11px] leading-tight text-ink-faint">
              {stream && (
                <span className="flex items-center gap-1.5" title={stream.detail}>
                  <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${stream.dot}`} />
                  {stream.label}
                </span>
              )}
              <span className="flex items-center gap-1.5" title={health.summary}>
                <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${HEALTH_DOT[health.tone]}`} />
                System {health.label}
              </span>
            </div>
          </div>

          <MenuSection>
            {productMenuLinks().map(({ link, nested }) => (
              <MenuLink key={link.href} href={link.href} path={path} nested={nested}
                onDone={() => setOpen(false)}>
                {link.label}
              </MenuLink>
            ))}
          </MenuSection>

          <MenuSection>
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
          </MenuSection>

          {username && (
            <MenuSection>
              <button
                role="menuitem"
                onClick={signOut}
                title={`Signed in as ${username}`}
                className="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                Sign out
              </button>
            </MenuSection>
          )}
        </div>
      )}
    </div>
  );
}

function MenuSection({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-border pt-1 first-of-type:mt-1">{children}</div>;
}

function MenuLink(
  { href, path, children, onDone, note, nested = false }:
  {
    href: string; path: string; children: React.ReactNode;
    onDone: () => void; note?: string; nested?: boolean;
  },
) {
  const current = path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      role="menuitem"
      aria-current={current ? "page" : undefined}
      onClick={onDone}
      className={`flex items-center justify-between gap-3 py-1.5 pr-3 text-[13px] hover:bg-surface-2 ${
        nested ? "pl-6 text-[12px]" : "pl-3"
      } ${
        current ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:text-ink"
      }`}
    >
      <span>{children}</span>
      {note && <span className="text-[11px] text-accent">{note}</span>}
    </Link>
  );
}
