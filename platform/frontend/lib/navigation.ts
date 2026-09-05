/**
 * Where things are in Trading Scene.
 *
 * ── Why this is data ────────────────────────────────────────────────────────
 *
 * The header used to list nine peers — Chart, Scanner, Alerts, Optimizers,
 * Backtests, Live trading, Journal, Operations, Shariah — as if a trader
 * visited each equally often. They do not. A day is spent on the chart and
 * the screener, with alerts and trading a click away; Operations is a
 * runbook, Shariah screening is a rare review, and optimizer results are a
 * research artefact. Putting them all on one row made the product read as a
 * dashboard of engineering pages rather than a workstation.
 *
 * Nothing was removed: every route still exists and is reachable. What
 * changed is altitude. Five primary destinations, each of which may carry a
 * secondary tab strip on its pages (`SectionTabs`), and a System menu for the
 * operator surfaces. The chart's phone drawer and the not-found page render
 * from the same lists, so a destination cannot be present in one and missing
 * from another.
 */

export interface NavLink {
  href: string;
  label: string;
}

/** The five destinations on the header row, in order. */
export const PRIMARY_LINKS: readonly NavLink[] = [
  { href: "/chart", label: "Chart" },
  { href: "/scanner", label: "Screener" },
  { href: "/deployments", label: "Trading" },
  { href: "/alerts", label: "Alerts" },
  { href: "/backtests", label: "Research" },
];

/** Operator and reference surfaces, under the System menu. */
export const SYSTEM_LINKS: readonly NavLink[] = [
  { href: "/operations", label: "Operations" },
  { href: "/shariah", label: "Shariah screening" },
  { href: "/getting-started", label: "Manual" },
];

/**
 * Secondary tabs within a primary destination. A page in one of these lists
 * shows the strip; the primary link is active for every page in its list.
 */
export const SECTION_TABS: Readonly<Record<string, readonly NavLink[]>> = {
  "/deployments": [
    { href: "/deployments", label: "Automations" },
    { href: "/journal", label: "Journal" },
  ],
  "/backtests": [
    { href: "/backtests", label: "Quick backtest" },
    { href: "/optimizers", label: "Optimizer results" },
  ],
};

/** Every route the navigation offers, primary and secondary and system. */
export function allNavLinks(): NavLink[] {
  const seen = new Set<string>();
  const out: NavLink[] = [];
  for (const link of [...PRIMARY_LINKS, ...Object.values(SECTION_TABS).flat(), ...SYSTEM_LINKS]) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    out.push(link);
  }
  return out;
}

/** The primary destination a path belongs to, or null (login, not-found). */
export function primaryFor(path: string): NavLink | null {
  for (const primary of PRIMARY_LINKS) {
    const tabs = SECTION_TABS[primary.href] ?? [];
    const hrefs = [primary.href, ...tabs.map((t) => t.href)];
    if (hrefs.some((h) => path === h || path.startsWith(`${h}/`))) return primary;
  }
  return null;
}

/** The tab strip a path should show, or null when its destination has none. */
export function sectionTabsFor(path: string): readonly NavLink[] | null {
  const primary = primaryFor(path);
  if (!primary) return null;
  return SECTION_TABS[primary.href] ?? null;
}

export function isSystemPath(path: string): boolean {
  return SYSTEM_LINKS.some((l) => path === l.href || path.startsWith(`${l.href}/`));
}

/** The product's one name. Strategy names belong beside strategies. */
export const PRODUCT_NAME = "Trading Scene";
