import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The in-product manual.
 *
 * ── What this page is for ──────────────────────────────────────────────────
 *
 * Someone who has never seen this project before should be able to open it and
 * come away knowing what the software is, which of its parts does what, and how
 * to carry out each of its major workflows without being told by a person.
 *
 * ── What it is deliberately NOT ────────────────────────────────────────────
 *
 * Not a guided tour, not a first-launch flow, not trading education, not
 * financial advice, and not strategy instruction. It is reachable from the
 * header at any time and it never opens itself. Nothing on it changes any
 * state: it is a static server component with no fetches, no forms and no
 * controls other than links to the pages it describes.
 *
 * ── Why the content is written the way it is ───────────────────────────────
 *
 * Every control, status word and refusal sentence quoted here was read out of
 * the current source, not remembered. Where the product declines to answer a
 * question — an unreadable Bot floor, an unassessed feed, unknown economics in
 * the Journal — this page uses the product's own words, because a reader who
 * learns a friendlier vocabulary here will misread the real screen.
 *
 * `tests/gettingStarted.test.ts` pins the parts a future edit could quietly
 * make untrue: Spot-only, Paper is not Live, Heikin Ashi and Renko are display
 * transforms, SELL is never gated, and a missing UI update is not evidence that
 * an order failed.
 */

export const metadata: Metadata = {
  title: "Manual · Trading Scene",
  description:
    "What Trading Scene is, how it relates to the Backtester, the execution Bot "
    + "and the Compute Helper, and how to operate each of its workflows.",
};

interface SectionSpec {
  id: string;
  title: string;
}

/** The table of contents and the document body are generated from one list. */
const SECTIONS: readonly SectionSpec[] = [
  { id: "what", title: "What Trading Scene is" },
  { id: "pieces", title: "The four pieces, and which one spends money" },
  { id: "flow", title: "The normal flow" },
  { id: "chart", title: "The Chart workspace" },
  { id: "types", title: "Chart types, and which ones invent prices" },
  { id: "scanner", title: "Scanner and symbol search" },
  { id: "alerts", title: "Alerts" },
  { id: "paper", title: "Paper, and what it does not prove" },
  { id: "live", title: "Live and manual trading" },
  { id: "automation", title: "Strategies and automation" },
  { id: "shariah", title: "Shariah Mode" },
  { id: "journal", title: "Journal" },
  { id: "operations", title: "Operations" },
  { id: "research", title: "Backtests and Optimizers" },
  { id: "safety", title: "Six things not to get wrong" },
  { id: "workflows", title: "Common workflows" },
  { id: "troubleshooting", title: "Troubleshooting" },
];

// ── Presentation ────────────────────────────────────────────────────────────
//
// Local to this page and intentionally plain: the application's own Card,
// border, surface and ink tokens. No new colour, no animation, no icon set.

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    // `scroll-mt` clears the 40px sticky header, so a table-of-contents jump
    // does not land with the heading underneath the navigation bar.
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-14">
      <h2 id={`${id}-heading`} className="text-base font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-2 space-y-3 text-sm leading-6 text-ink-muted">{children}</div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="mt-2 space-y-2 text-sm leading-6 text-ink-muted">{children}</div>
    </div>
  );
}

/**
 * A stated fact the reader is expected to carry away.
 *
 * Three tones and no more. `caution` is the amber the rest of the product uses
 * for "not resolved yet"; `critical` is the loss red, reserved for the handful
 * of statements where a wrong assumption costs real money.
 */
function Callout({
  tone = "note", title, children,
}: {
  tone?: "note" | "caution" | "critical";
  title: string;
  children: ReactNode;
}) {
  const box = {
    note: "border-border bg-surface-2/60",
    caution: "border-warn/40 bg-warn/10",
    critical: "border-down/40 bg-down/10",
  }[tone];
  const heading = {
    note: "text-ink",
    caution: "text-warn",
    critical: "text-down",
  }[tone];
  return (
    <div className={`rounded-lg border p-3 ${box}`}>
      <p className={`text-sm font-semibold ${heading}`}>{title}</p>
      <div className="mt-1 space-y-2 text-sm leading-6 text-ink-muted">{children}</div>
    </div>
  );
}

/**
 * A left-to-right sequence of steps.
 *
 * Normal HTML and CSS — an ordered list of boxes with a separator drawn between
 * them — so assistive technology reads it as the ordered list it is. It scrolls
 * inside its own container; nothing here may make the page scroll sideways.
 */
function Flow({ label, steps }: { label: string; steps: readonly string[] }) {
  return (
    <div className="overflow-x-auto">
      <ol aria-label={label} className="flex min-w-max items-stretch gap-1.5">
        {steps.map((step, i) => (
          <li key={step} className="flex items-stretch gap-1.5">
            {i > 0 && (
              <span aria-hidden="true" className="self-center text-ink-faint">
                &rarr;
              </span>
            )}
            <span className="flex items-center rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs leading-tight text-ink">
              {step}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Term / meaning pairs. A description list, because that is what it is. */
function Terms({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="divide-y divide-border rounded-lg border border-border bg-surface">
      {rows.map(([term, meaning]) => (
        <div
          key={term}
          className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(9rem,15rem)_1fr] sm:gap-3"
        >
          <dt className="text-sm font-medium text-ink">{term}</dt>
          <dd className="text-sm leading-6 text-ink-muted">{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

function Detail({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-border bg-surface px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-ink">{summary}</summary>
      <div className="mt-2 space-y-2 text-sm leading-6 text-ink-muted">{children}</div>
    </details>
  );
}

function Ul({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

function Ol({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>;
}

/** A control or status word, spelled exactly as the product spells it. */
function C({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-surface-2 px-1 py-0.5 text-[13px] text-ink">{children}</span>
  );
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export default function GettingStarted() {
  return (
    <div className="mx-auto max-w-[1100px] px-3 py-4 sm:px-4">
      <header className="max-w-3xl">
        <h1 className="text-lg font-semibold text-ink">Getting started</h1>
        <p className="mt-1 text-sm leading-6 text-ink-muted">
          What this application is, how its parts relate to one another, and how to
          operate each of its workflows. It describes the software only: there is no
          trading advice here, no strategy instruction, and no recommendation about
          what to buy or sell.
        </p>
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          Nothing on this page changes anything. Every control it names lives on the
          page it names.
        </p>
      </header>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start">
        {/* The body comes first in the DOM: the contents list is a shortcut, not the page. */}
        <div className="min-w-0 space-y-8 lg:order-first">
          <Callout tone="note" title="If you read only one paragraph">
            <p>
              Trading Scene charts Binance <strong className="text-ink">Spot</strong>{" "}
              markets, watches them for conditions you define, and decides when to
              trade. It holds no exchange credential and places no order itself: it
              hands the decision to a separate execution Bot, and the Bot is the only
              component that talks to Binance. Everything is Spot — there is no
              futures, leverage, margin or short selling anywhere in this product.
            </p>
          </Callout>

          {/* ── 1 ── */}
          <Section id="what" title={SECTIONS[0]!.title}>
            <p>
              Trading Scene is the main trading application: a chart workspace, a
              market scanner, notification alerts, manual Spot order entry, automated
              strategy deployments, a trade journal and an operator console. It is a
              website-style application you sign in to and keep open. Opening its root
              address takes you straight to the chart; there is no landing page.
            </p>
            <p>
              It is the component that <strong className="text-ink">decides</strong>. It
              loads and stores Binance Spot candles, evaluates strategies and alert
              conditions on them, and produces buy and sell decisions. It does not
              execute them.
            </p>
            <Terms
              rows={[
                ["Market", <>Binance Spot only, long-only. USDT-quoted pairs are the working universe.</>],
                ["Credentials", <>None. No Binance API key exists anywhere in this application.</>],
                ["Data", <>Public Binance Spot endpoints for history, plus a live websocket for the forming candle.</>],
                ["Sign-in", <>On by default. The login screen says <C>You stay signed in on this device for 90 days</C>. An installation configured without authentication shows no <C>Sign out</C> control at all, rather than a button that does nothing.</>],
                ["Navigation", <><C>Chart</C>, <C>Scanner</C>, <C>Alerts</C>, <C>Optimizers</C>, <C>Backtests</C>, <C>Live trading</C>, <C>Journal</C>, <C>Operations</C>, <C>Shariah</C> — and this page, from the header.</>],
              ]}
            />
          </Section>

          {/* ── 2 ── */}
          <Section id="pieces" title={SECTIONS[1]!.title}>
            <p>
              Four separate programs. They are deliberately kept apart, and the
              boundary that matters most is the last column of this table.
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-[46rem] w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-ink-faint">
                    <th scope="col" className="py-2 pr-3 font-medium">Program</th>
                    <th scope="col" className="py-2 pr-3 font-medium">What it is</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Where it runs</th>
                    <th scope="col" className="py-2 font-medium">Places orders</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border align-top">
                  <tr>
                    <th scope="row" className="py-2 pr-3 font-medium text-ink">Trading Scene</th>
                    <td className="py-2 pr-3">This application. Charts, Scanner, alerts, manual trading, deployments, Journal, Operations.</td>
                    <td className="py-2 pr-3">A browser, against the Platform server.</td>
                    <td className="py-2">No — it decides.</td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 pr-3 font-medium text-ink">Backtester</th>
                    <td className="py-2 pr-3">A separate local research application: backtests, optimizers, walk-forward runs, results, and distributed compute across trusted Macs.</td>
                    <td className="py-2 pr-3">Its own local web application, loopback only.</td>
                    <td className="py-2">No — it never trades.</td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 pr-3 font-medium text-ink">Execution Bot</th>
                    <td className="py-2 pr-3">Real-money execution infrastructure. It receives a decision, applies its own guards, and sends the order.</td>
                    <td className="py-2 pr-3">A separate service. Not a page you browse day to day.</td>
                    <td className="py-2 font-medium text-warn">Yes — and only it.</td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 pr-3 font-medium text-ink">Compute Helper</th>
                    <td className="py-2 pr-3">A small helper runtime for an additional trusted Mac that only lends computing capacity to the Backtester.</td>
                    <td className="py-2 pr-3">The lending Mac, with a small loopback status page.</td>
                    <td className="py-2">No — it has no market access at all.</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <Callout tone="critical" title="Only the Bot holds exchange credentials">
              <p>
                Trading Scene has no Binance API key, and neither does the Backtester
                nor the Compute Helper. A live order exists because Trading Scene sent a
                decision to the Bot and the Bot accepted it. That is why an order can
                still be declined after this application has agreed to it, and why{" "}
                <A href="/operations">Operations</A> labels every card with whether the
                Platform or the Bot is the authority for its numbers.
              </p>
            </Callout>

            <Detail summary="How the Backtester and the Compute Helper relate to this application">
              <p>
                The Backtester is a separate program in a separate repository, started
                from its own checkout and served on loopback only. It contains no
                strategy engine of its own: it runs the same canonical engine this
                Platform ships, so a research result and a live decision come from one
                implementation rather than two that can drift.
              </p>
              <p>
                Its <C>Distributed Compute</C> page is optional. Ordinary runs, history,
                results and settings need no second machine. When one is used, the
                Compute Helper runs on that machine, advertises the capacity its owner
                chose, pulls work, and returns validated results. It creates no runs of
                its own and can reach no exchange.
              </p>
              <p>
                Inside Trading Scene, <A href="/optimizers">Optimizers</A> is a read-only
                view of results the research trees produced. There is no link from here
                into the Backtester and no way to start a research run from this
                application; if no research checkout is configured, the page reports an
                empty registry rather than pretending the research lives here.
              </p>
            </Detail>
          </Section>

          {/* ── 3 ── */}
          <Section id="flow" title={SECTIONS[2]!.title}>
            <p>
              Most sessions follow the same shape. Nothing forces this order, and every
              step is reachable on its own.
            </p>
            <Flow
              label="The normal Trading Scene flow"
              steps={[
                "Scanner or symbol search",
                "Chart",
                "Analysis",
                "Alert, or a trade decision",
                "Paper or Live",
                "Order and position",
                "Journal and Operations",
              ]}
            />
            <Terms
              rows={[
                ["Find something", <>The <A href="/scanner">Scanner</A> ranks Spot symbols against a fixed multi-timeframe checklist. Symbol search — <C>/</C> on the chart — goes straight to one you already have in mind.</>],
                ["Look at it", <>The <A href="/chart">Chart</A> workspace: up to sixteen panes, indicators, drawings, Bar Replay.</>],
                ["Decide what to watch for", <>An <A href="/alerts">alert</A> notifies you. It cannot trade.</>],
                ["Decide to trade", <>Either by hand, in the chart&rsquo;s <C>Trade</C> ticket, or by deploying a strategy on <A href="/deployments">Live trading</A>.</>],
                ["Prove it first", <>A deployment can run in Paper, which simulates the fill instead of sending it.</>],
                ["Watch it", <>Orders and positions appear in the ticket and as chart overlays. Any order row opens a <C>Timeline</C> of the evidence behind it.</>],
                ["Account for it", <>The <A href="/journal">Journal</A> accumulates what happened; <A href="/operations">Operations</A> says whether the machinery is healthy.</>],
              ]}
            />
          </Section>

          {/* ── 4 ── */}
          <Section id="chart" title={SECTIONS[3]!.title}>
            <p>
              <A href="/chart">Chart</A> is a workspace of one to sixteen independent
              panes. There is no &ldquo;main&rdquo; chart: every pane is a full chart
              with its own symbol, timeframe, chart type, history depth and moving
              averages.
            </p>

            <Panel title="The active pane">
              <p>
                One pane is focused at a time. Click a pane to focus it. The controls
                along the top of the workspace — symbol, timeframe, chart type,{" "}
                <C>Indicators</C>, <C>Replay</C> — act on the focused pane.
              </p>
              <p>
                <strong className="text-ink">Focus is only focus.</strong> Changing
                which pane you are looking at does not move an order you have already
                staged in the trading ticket. If a staged ticket and the focused pane
                disagree, the ticket says so in as many words: it is staged for one
                symbol, it stays there, and you clear it to trade the other.
              </p>
            </Panel>

            <Terms
              rows={[
                ["Layouts", <>The <C>Chart layout</C> control offers 27 arrangements from <C>Single</C> up to <C>Grid 4 &times; 4</C>, including asymmetric shapes such as <C>One left, three right</C>. Sixteen panes is the ceiling.</>],
                ["Maximize", <>Each pane can fill the workspace on its own. The other panes keep their state and return unchanged.</>],
                ["Synchronization", <>The <C>Sync</C> menu has five independent switches: <C>Symbol</C>, <C>Interval</C>, <C>Crosshair</C>, <C>Time</C> and <C>Date range</C>. <C>Symbol</C> and <C>Crosshair</C> are on by default — the useful combination for reading several timeframes of one instrument at the same instant. With one pane there is nothing to synchronise and the menu is unavailable.</>],
                ["Symbols", <>Per pane. Press <C>/</C> anywhere on the chart to open symbol search, or use the symbol button in the toolbar. Whether a change reaches the other panes is the <C>Symbol</C> sync switch&rsquo;s business.</>],
                ["Timeframes", <>Eleven: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h and 1d. Six sit in the strip; the rest are under <C>More timeframes</C>.</>],
                ["Indicators", <><C>Indicators</C> browses the library and applies a study to the focused chart. Studies are per pane, and an oscillator gets its own sub-pane beneath the price.</>],
                ["Drawings", <>25 tools — trend lines, rays, horizontals, channels, pitchfork, Fibonacci retracement and extension, shapes, brush, text and callouts, and the measuring tools. Drawings are stored <strong className="text-ink">per symbol</strong>, so every pane showing that instrument shows the same drawings.</>],
                ["Ranges", <>Shortcuts <C>1D</C>, <C>5D</C>, <C>1M</C>, <C>3M</C>, <C>6M</C>, <C>YTD</C>, <C>1Y</C> and <C>All</C> set the visible span. <C>History depth</C>, under <C>More chart controls</C>, decides how many bars are loaded at all: <C>2K</C>, <C>10K</C>, <C>50K</C> or <C>All</C>.</>],
                ["Price scale", <>Linear or logarithmic, auto-scale on or off, and a reset. Dragging the scale by hand turns auto-scale off, which is what stops the chart snapping back under you.</>],
                ["Saved layouts", <>The whole workspace — panes, symbols, timeframes, chart types — saves as a named layout, with <C>Save layout</C> or <C>⌘S</C> / <C>Ctrl+S</C>. Autosave keeps a named layout current, and a failed save is reported rather than swallowed.</>],
                ["Feed badge", <>Each pane states its own live connection and, when it is not live, why. <C>connecting…</C>, then <C>connected — waiting for data</C> until the first update arrives — only then <C>live</C>, and that word is hidden because it is the normal state. Otherwise <C>not live</C> (replay), <C>reconnecting…</C>, <C>stream refused — trying another host…</C>, <C>live stream unavailable — history still updates</C>, or <C>feed stalled — price is not current</C>. Hover the badge for the full sentence, including which host answered what.</>],
              ]}
            />

            <Panel title="Bar Replay">
              <p>
                <C>Replay</C> moves the chart back to a chosen moment and walks forward
                through the history already loaded. Pick a date and time, then step with
                Previous and Next — one real bar each — or play at <C>1x</C>,{" "}
                <C>2x</C> or <C>5x</C> until the end of the captured history.
              </p>
              <p>
                Everything on screen is bounded to the replay bar&rsquo;s close: candles,
                the current price, moving averages, script plots and higher-timeframe
                feeds. Changing symbol or timeframe keeps the moment and resolves the
                last completed bar at or before it.
              </p>
              <Callout tone="caution" title="Replay disables live actions">
                <p>
                  Manual trading, automation, paper actions and creating or editing a
                  live alert are unavailable until you leave Replay — the trading panel
                  reads <C>Exit Replay to trade</C>, and the alert bells read{" "}
                  <C>Exit Replay to create live alerts</C>. Saved drawings are hidden,
                  because the product does not record when a drawing was made and will
                  not imply you had it at that moment; drawings made inside a replay
                  session are discarded on exit. Replay paper trading does not exist in
                  V1.
                </p>
              </Callout>
            </Panel>
          </Section>

          {/* ── 5 ── */}
          <Section id="types" title={SECTIONS[4]!.title}>
            <p>
              The chart-type menu has two shelves, and the difference between them is
              not cosmetic.
            </p>
            <Terms
              rows={[
                ["Presentations", <><C>Candles</C>, <C>Bars</C>, <C>Line</C> and <C>Area</C> draw the exchange&rsquo;s own candles. Nothing is recomputed, and no price appears that did not trade.</>],
                ["Transforms", <><C>Heikin Ashi</C> and <C>Renko · ATR(14)</C> derive their own bars. The prices they draw never traded. That is the point of them, and it is why they sit under their own heading, <C>Transforms · display only</C>, and are labelled wherever they are active.</>],
              ]}
            />
            <Callout tone="critical" title="A transformed chart is a lens, not a price">
              <p>
                Orders, alerts, strategies, backtests, Paper, Shariah screening and
                stored market data all use the canonical exchange candles. None of them
                can see a Heikin Ashi or Renko value. A synthetic bar is never execution
                authority: you cannot trade at a price that did not trade.
              </p>
              <p>
                While a transform is active, the chart-type button carries a written
                label. A canonical chart shows only its glyph, so a label on that button
                always means you are not looking at raw candles.
              </p>
            </Callout>
            <Detail summary="Why Renko hides markers, drawings and indicator panes">
              <p>
                A Renko brick is not a time bar. One candle can complete several bricks,
                and hundreds of candles can complete none. Anything anchored to a
                timestamp — a script plot, a trade marker, a drawing, an indicator
                sub-pane — has no honest position on a brick axis, so Renko hides those
                layers rather than drawing them where they do not belong, and says so on
                the chart. They are unchanged and return on any other chart type.
              </p>
              <p>
                Heikin Ashi emits exactly one bar per canonical bar at that bar&rsquo;s
                own time, so it keeps all of them.
              </p>
              <p>
                Brick size is fixed at ATR(14) in V1 and is not adjustable. Kagi, Range,
                Point &amp; Figure and Line Break are not implemented, and the menu
                offers only what exists.
              </p>
            </Detail>
          </Section>

          {/* ── 6 ── */}
          <Section id="scanner" title={SECTIONS[5]!.title}>
            <p>
              <A href="/scanner">Scanner</A> — headed <C>Spot Scanner</C> — ranks Binance
              Spot symbols against a fixed 1h / 15m / 5m checklist and shows the result
              as one dense table. The calculation belongs to a separate service; this
              page is the authenticated window onto its cached snapshot, refreshed on
              screen every fifteen seconds while the tab is visible.
            </p>
            <p>
              Reading the Scanner never fetches new market data. <C>Refresh</C>, adding a
              symbol and running a calibration are explicit operations you ask for.
            </p>
            <Terms
              rows={[
                ["Columns", <>Grouped and collapsible: <C>Symbol</C>, <C>Strategy</C>, <C>EMA</C>, <C>RSI</C>, <C>MACD</C>, <C>VFI</C>, <C>ADX</C>, <C>VWAP</C>, <C>Candles</C>, <C>Supertrend</C>, <C>S&amp;R</C> and <C>Pivots</C>. <C>More columns</C> reveals the rest.</>],
                ["What the percentages are", <>The page states it in its own footer: checklist percentages are the share of conditions currently passing, <strong className="text-ink">not probabilities</strong>, and the Confluence Score is not a probability either.</>],
                ["Shariah column", <><C>ELIGIBLE</C>, <C>REVIEW</C>, <C>EXCLUDED</C>, or <C>UNKNOWN</C> for an asset that is not in the screened registry. <C>Shariah-eligible only</C> filters to what Shariah Mode would let you buy.</>],
                ["Unresolved rows", <>A symbol that does not resolve to an exact active Binance Spot market stays <C>unresolved</C> rather than being substituted with something similar, and its Spot actions are unavailable.</>],
                ["Stale cells", <>Marked, with the reason on hover: the source bar is older than twice its own timeframe.</>],
              ]}
            />
            <p>
              Expanding a row inspects it. The row&rsquo;s actions only prefill other
              workflows — the page says so itself, and none of them trades:
            </p>
            <Ul>
              <li><C>Open Chart</C> — opens that exact Spot pair on the chart.</li>
              <li><C>Create Alert</C> — opens the level-alert review form with the symbol filled in. It saves and arms nothing.</li>
              <li><C>Trade</C> — opens the manual ticket with the symbol filled in and nothing else. Side, size, review and confirmation are unchanged, and the Scanner cannot submit an order.</li>
              <li><C>Backtest · unavailable</C> — deliberately disabled: no strategy here is an exact representation of the Scanner checklist, and a calibration is not a backtest.</li>
            </Ul>
            <p>
              When the Scanner service cannot be reached the page says{" "}
              <C>Scanner service unavailable.</C> and offers <C>Retry</C>. It does not
              present an empty table as &ldquo;nothing found&rdquo;. If the Shariah
              registry cannot be read it removes the status column and says so, adding
              that buying is gated by the server either way.
            </p>
          </Section>

          {/* ── 7 ── */}
          <Section id="alerts" title={SECTIONS[6]!.title}>
            <Callout tone="note" title="Two different things have been called an alert">
              <p>
                A <strong className="text-ink">notification alert</strong> pushes a
                message to your devices and cannot move money — that isolation is
                enforced in the backend, not merely intended. An{" "}
                <strong className="text-ink">automation</strong> is a deployment that
                runs a strategy and sends real orders. They have separate pages,
                separate buttons and separate wording: the chart&rsquo;s bell arms a
                notification, and starting an automation is a dialog titled{" "}
                <C>Automate trading on …</C> whose primary button reads{" "}
                <C>Start trading</C>.
              </p>
            </Callout>
            <p>
              Notification alerts live on <A href="/alerts">Alerts</A> and on the
              chart: the bell in the toolbar, a click on the price scale, and the
              bells beside each line in the moving-average panel. Each alert watches
              one condition on one symbol and one timeframe.
            </p>
            <Terms
              rows={[
                ["What can be watched", <>Seven families: <C>Price</C>, <C>Moving average</C>, <C>MA cross</C>, <C>Support / resistance</C>, <C>Pivot level</C>, <C>RSI</C> and <C>MACD</C>. Support/resistance and pivot alerts are armed from the Alerts page, with <C>Add level alert</C>.</>],
                ["Filters", <>A level alert can additionally require an RSI or moving-average condition on its own timeframe. While a filter is not met the alert stays silent; it does not queue up and fire later.</>],
                ["How often it may fire", <>Four modes: <C>Once per bar close</C> (the default, and the only one that reads completed candles only), <C>Once per bar</C>, <C>Once per minute</C>, and <C>Once only</C> — which turns the alert off permanently after it fires.</>],
                ["Intrabar modes", <>The form states it verbatim before you choose one: <C>May trigger before the candle closes. The condition can become false again before bar close.</C></>],
                ["Cooldown", <>Minutes of silence after a fire, so a slow approach is not re-announced on every closing bar. Zero means notify on every qualifying bar.</>],
                ["Lifecycle", <>A row is <C>Active</C>, <C>Paused</C>, or <C>Fired once — done</C> for a spent once-only alert. Editing an alert keeps its history: it does not create a second one, and two configurations are never live at once.</>],
                ["Delivery", <>Web Push. The <C>Mobile notifications</C> card registers this device and can send a <C>Test</C>. On iPhone, the app must first be installed to the Home Screen — an Apple requirement, not a product choice.</>],
              ]}
            />
            <p>
              The second card on the Alerts page is <C>Recently fired</C>, and it reports
              delivery honestly: <C>sent to n device(s)</C>, counts of failed and pruned
              subscriptions, <C>delivery failed</C>, or <C>no device registered</C>.
            </p>
            <Callout tone="caution" title="An alert is a notification, not an instruction">
              <p>
                A fired alert places no order, opens no position and starts no
                automation. It tells you something happened. What you do next is a
                separate, explicit action.
              </p>
            </Callout>
          </Section>

          {/* ── 8 ── */}
          <Section id="paper" title={SECTIONS[7]!.title}>
            <p>
              Paper is a delivery mode on a deployment —{" "}
              <C>Paper (simulate fills — no orders)</C>. It evaluates the same strategy
              on the same live bars and records the signal exactly as a live deployment
              would, then{" "}
              <strong className="text-ink">simulates the fill instead of sending it</strong>.
              Results are behind the <C>Paper results</C> button on the deployment row,
              and the row itself is badged <C>paper (simulated)</C>.
            </p>
            <Terms
              rows={[
                ["What it does prove", <>That the strategy fires when you expect it to, on live data, at the cost model the research runs use — 0.1% commission per side.</>],
                ["What it cannot prove", <>Anything about execution. Paper fills at the signal bar&rsquo;s close, with no slippage and no partial fill. A live order is a market order and will differ.</>],
                ["Refusals are kept", <>A sell with nothing held, or a buy while already long, is recorded rather than swallowed: a divergence between the platform&rsquo;s idea of the position and the simulation&rsquo;s is one of the things a paper run exists to surface.</>],
                ["It cannot place an order", <>The paper engine imports nothing at all, and a build-time check walks its entire dependency graph and fails if it can reach a dispatcher, a credential or an exchange client.</>],
                ["Its own results panel", <>Realized, commission, closed trades, win rate, open position and simulated size, above a table of every simulated fill with its bar time in UTC.</>],
              ]}
            />
            <Callout tone="critical" title="Paper is not Live">
              <p>
                A profitable paper run is evidence about a strategy&rsquo;s signals. It
                is not evidence that the same sequence would have filled at those prices
                with real money. The <A href="/journal">Journal</A> keeps real and Paper
                totals in two separate cards and never adds them together, for exactly
                this reason.
              </p>
            </Callout>
          </Section>

          {/* ── 9 ── */}
          <Section id="live" title={SECTIONS[8]!.title}>
            <p>
              Manual trading happens in the chart&rsquo;s <C>Trade</C> ticket, headed{" "}
              <C>Manual Binance Spot trading</C>. The path a real order takes is short,
              and there is exactly one place in it where money moves:
            </p>
            <Flow
              label="How a manual order reaches the exchange"
              steps={[
                "Trading Scene ticket",
                "Review and explicit confirmation",
                "Platform gates: halt, risk, Shariah",
                "Execution Bot",
                "Binance Spot",
              ]}
            />
            <Terms
              rows={[
                ["Order types", <>Two, and nothing else is offered: <C>Market</C> and <C>Limit</C>. A limit ticket adds a <C>Limit price</C> field with a hint reading it against the live quote.</>],
                ["Instrument", <>The ticket trades the instrument named in its <C>Trading</C> strip, not whichever pane you happen to be looking at.</>],
                ["Sides and quotes", <><C>SELL</C> is shown with the live bid, <C>BUY</C> with the live ask, and the spread between them. With no live quote it says so, and says that the last chart close is a last trade rather than a bid or an ask.</>],
                ["Sizing", <>A BUY is sized in <C>Quote amount</C> (USDT). A SELL is sized in <C>Base quantity</C> (the coin). The quick-fill row — 1, 5, 10, 25, 50, 75, 100 percent — writes a number into that same field, and always rounds down.</>],
                ["Balances", <>An <C>Account balances</C> card shows available and reserved amounts per asset, and states the maximum order at the current state. If your size is not allowed, the ticket says which rule stopped it: available balance, minimum quantity, lot step, or minimum order value.</>],
                ["Confirmation", <>Nothing submits from the ticket. <C>Review BUY</C> or <C>Review SELL</C> opens <C>Confirm manual Spot order</C>, which restates account, mode, symbol, side and type, amount, limit price and protection. On a real-funds account you must additionally tick that you confirm the order uses real funds on Binance mainnet before <C>Confirm</C> is enabled.</>],
                ["Selling", <>A SELL is scoped to the symbol and account it is issued for. When positions are tracked you must pick one, or choose <C>Unassociated wallet sell</C> explicitly. Manual buys and sells are never paired into a position by the product, and no cost basis is reconstructed for them.</>],
                ["Monitoring", <>The <C>Orders</C> tab filters by <C>All</C>, <C>Working</C>, <C>Filled</C>, <C>Cancelled</C>, <C>Rejected</C> and <C>Blocked</C>. Any row opens a <C>Timeline</C>: a read-only projection of the evidence behind that one order.</>],
              ]}
            />
            <Callout tone="caution" title="Take profit and stop loss here are bot-managed">
              <p>
                The ticket states it above the field: TP/SL entered here activates only
                after an entry fill and is{" "}
                <strong className="text-ink">not resting on the exchange</strong>. If the
                Bot is down, nothing protects the position.
              </p>
            </Callout>
            <Callout tone="critical" title="A refusal is usually the system working">
              <p>
                An order can be declined before it ever reaches the exchange. The
                blocked-order chips name which authority did it:{" "}
                <C>Shariah policy</C>, <C>Risk limit</C>, <C>Operator halt</C>,{" "}
                <C>Authentication</C>, <C>Exchange</C>, or a plain <C>Rejected</C>. A
                refusal is a decision, not a fault, and the correct response is to read
                what it says rather than to try again.
              </p>
            </Callout>
            <Detail summary="Two more things the ticket does on purpose">
              <p>
                <strong className="text-ink">Changing the chart symbol clears the
                ticket</strong>, and it tells you: it was prepared for one instrument and
                the chart now shows another. That is deliberate — a staged size and a
                staged limit price mean nothing on a different coin. Changing the
                connected account keeps the numbers but clears the mainnet
                acknowledgement and the chosen position.
              </p>
              <p>
                <strong className="text-ink">The platform cannot flatten a
                position.</strong> It holds no exchange credential and does not know the
                fill price of anything it did not open, so inventing an exit would put
                real money behind a guess. Close positions in the execution Bot or on the
                exchange. There is no &ldquo;close everything&rdquo; control anywhere in
                this product, and its absence is deliberate.
              </p>
            </Detail>
          </Section>

          {/* ── 10 ── */}
          <Section id="automation" title={SECTIONS[9]!.title}>
            <p>
              <A href="/deployments">Live trading</A> is where a strategy is deployed. A
              deployment names a symbol, a timeframe, its strategy parameters, a buy size
              in quote USDT and a delivery mode. From then on the live runner evaluates
              it on every confirmed bar close and acts on the result.
            </p>
            <Terms
              rows={[
                ["Delivery modes", <><C>Custom bot (FastAPI)</C> and <C>3Commas Signal bot</C> send real orders. <C>Paper (simulate fills — no orders)</C> simulates. <C>Off (log only — no orders, no simulation)</C> records the signal and does neither.</>],
                ["Creating one", <>A new deployment is <C>Created paused. Activate it to start streaming and firing alerts.</C> Nothing begins as a side effect of creating it.</>],
                ["Activating one", <>Always a deliberate second step, behind an <C>Activate deployment</C> dialog with a checkbox that is never remembered. The wording names the mode and the exact size — for a live deployment, that activating it starts trading immediately and sends real orders of that size to your bot.</>],
                ["States", <><C>active</C>, <C>paused</C>, <C>stopped</C>. A row shows its buy size, whether it is in a position or flat, and how long ago its last bar was. The list refreshes every five seconds.</>],
                ["Evidence", <>Each row opens a <C>Timeline</C> of recent intents and outcomes for that deployment, and a paper deployment additionally offers <C>Paper results</C>.</>],
                ["Position state", <>The platform asks the Bot which symbols it currently holds rather than assuming its own record is the truth.</>],
              ]}
            />
            <p>
              Strategy methodology, scoring and optimizer semantics are research work and
              are not configured here. This page is where a chosen configuration is put
              to work and watched.
            </p>
          </Section>

          {/* ── 11 ── */}
          <Section id="shariah" title={SECTIONS[10]!.title}>
            <p>
              Shariah Mode restricts <strong className="text-ink">new exposure</strong>{" "}
              to assets screened as eligible. It is a server-side setting with its console
              at <A href="/shariah">Shariah</A>, headed <C>Shariah review</C>, and it is
              off by default. What follows describes how the software behaves; the
              screening methodology itself is a separate document and is not re-argued
              here.
            </p>
            <Terms
              rows={[
                ["ELIGIBLE", <>Screened, and no material connection to an excluded activity was found.</>],
                ["REVIEW", <>Not resolved. Mixed, unclear or insufficient evidence — and where an unscreened or stale asset also lands. It is not a soft yes.</>],
                ["EXCLUDED", <>Screened, and materially connected to an excluded activity.</>],
                ["UNSCREENED / STALE", <>Lifecycle, not classification. Both read as <C>REVIEW</C>, and a stale asset needs a full fresh review — its old classification can never be reconfirmed.</>],
              ]}
            />
            <Panel title="What the mode actually gates">
              <Ul>
                <li>
                  <strong className="text-ink">BUY / new exposure.</strong> When
                  enforcing, a buy requires <C>ELIGIBLE</C>. <C>REVIEW</C>,{" "}
                  <C>EXCLUDED</C> and an asset whose identity cannot be resolved all
                  block it. Absence of a classification fails closed.
                </li>
                <li>
                  <strong className="text-ink">SELL / exit — never gated.</strong> In
                  every status and every mode, including for an asset that was later
                  excluded and one whose identity cannot be resolved. What you hold must
                  always remain exitable.
                </li>
                <li>
                  <strong className="text-ink">Nothing is liquidated.</strong> The
                  console says it when you turn the mode on: selling or reducing is
                  always allowed, and no position was changed. Enforcement blocks the
                  next entry; it does not sell what you already hold.
                </li>
              </Ul>
              <p>
                One backend gate serves every path that can create exposure — manual
                trading, automated live, Paper and the live test signal — so Paper and
                Live agree by construction. A disabled button in the interface is
                convenience; the backend is the enforcement.
              </p>
            </Panel>
            <Panel title="The Bot floor">
              <p>
                This Platform can only gate the signals it originates. A signal that
                reaches the Bot by another route is gated by the Bot&rsquo;s own floor,
                so the console reports that floor as a separate fact and never as a tick
                it inferred:
              </p>
              <Terms
                rows={[
                  ["Bot floor: checking", <>Not read yet.</>],
                  ["Bot floor: not required", <>Shariah Mode is off here, so no floor is claimed.</>],
                  ["Bot floor: enforcing", <>This Platform enforces and the Bot confirms the same floor.</>],
                  ["Bot floor: not armed", <>No Bot control channel is configured, so no floor was pushed. Paths this Platform originates are still gated; a signal sent straight to a Bot webhook is not.</>],
                  ["Bot floor: unknown", <>The Bot could not be reached. <strong className="text-ink">Unknown is not off, and not a confirmation.</strong></>],
                  ["Bot floor: out of sync", <>The Bot reports a different floor from the one this Platform enforces. Re-apply the mode change to converge them.</>],
                  ["Bot floor: could not be read", <>The enforcement state itself could not be read. Treat it as unknown, not as off.</>],
                ]}
              />
              <p>
                Each of those carries a shape as well as a colour, so two greens are
                distinguishable without relying on colour alone.
              </p>
            </Panel>
            <Panel title="How review data enters the product">
              <p>
                Deliberately, in three operator steps, with no automated classification
                anywhere in the path:
              </p>
              <Ol>
                <li><C>Download next 20 for ChatGPT</C> exports the next batch of assets that need review as a JSON file.</li>
                <li>You review them outside the product and get a JSON document back.</li>
                <li>You load or paste that document, press <C>Check results</C>, then <C>Import &amp; publish</C> — the console states that this one action is your approval for the whole batch.</li>
              </Ol>
              <p>
                Published decisions are append-only: a later decision adds a row, it never
                rewrites one. A universe snapshot is immutable in the same way, and later
                publications never rewrite one.
              </p>
            </Panel>
          </Section>

          {/* ── 12 ── */}
          <Section id="journal" title={SECTIONS[11]!.title}>
            <p>
              <A href="/journal">Journal</A> — headed <C>Trade Journal</C> — is a
              chronological record of Spot activity and the realized outcomes that are
              actually known. It is a projection of existing evidence, not a second
              ledger, and it answers a different question from a Timeline: the Journal
              says what accumulated, a Timeline explains what happened to one order.
            </p>
            <Terms
              rows={[
                ["Real and Paper", <>Two summary cards, <C>Real money evidence</C> and <C>Paper evidence</C>, never added together. Every row carries a <C>REAL</C> or <C>PAPER</C> badge alongside <C>MANUAL</C>, <C>AUTOMATED</C> or <C>PAPER</C> as its source.</>],
                ["Unknown economics", <>A value that was never persisted renders as the word <C>Unknown</C>, styled as neither profit nor loss. It is left out of totals and win/loss counts rather than counted as zero.</>],
                ["INCOMPLETE", <>A row whose evidence is incomplete is tagged, and the reason is printed under its metrics.</>],
                ["Filters", <><C>From</C>, <C>Through</C>, <C>Source</C>, <C>Symbol</C> and a <C>Summary</C> grouping of daily, weekly or monthly.</>],
                ["Times", <>Row times are your own local time. The <C>From</C> / <C>Through</C> filter is inclusive and uses the UTC date, matching the exchange bar timestamps on the chart. The page states this in one line above the table.</>],
                ["Bounds", <>A summary scan that hit its cap is marked <C>Summary bound reached</C> rather than presented as a complete total, and an <C>Evidence limits</C> disclosure lists what this projection cannot answer.</>],
              ]}
            />
          </Section>

          {/* ── 13 ── */}
          <Section id="operations" title={SECTIONS[12]!.title}>
            <p>
              <A href="/operations">Operations</A> is the console for whoever is holding
              the system when something is wrong. It refreshes every ten seconds, carries
              one overall verdict — <C>Healthy</C>, <C>Attention</C>, <C>Degraded</C> or{" "}
              <C>Halted</C> — and prefixes every card with whether the{" "}
              <C>Platform</C> or the <C>Bot</C> is the authority for its numbers.
            </p>
            <Terms
              rows={[
                ["Health rows", <>Seven, each with its own evidence disclosure: <C>Market data</C>, <C>Live runner</C>, <C>Alerts</C>, <C>Scanner</C>, <C>Database</C>, <C>Webhook delivery</C> and <C>Trading Mode</C>.</>],
                ["Trading mode", <><C>LIVE</C> — this process holds the emitter lease and will send real buy and sell signals. <C>STANDBY</C> — enabled, but another process holds the lease, so this one will not emit. <C>HALTED</C> — every emission is refused until it is resumed. <C>DISABLED</C> — the live runner is switched off in this environment, which is the default.</>],
                ["Halting", <><C>Halt all trading</C> requires a written reason, because whoever finds the system halted needs to know why. Resuming is deliberately harder: <C>Resume trading…</C> asks whether the reason is gone, and only then offers <C>Yes, resume trading</C>.</>],
                ["Risk limits", <>Configured exposure and concurrent positions, each off until a number is set. Note that this platform has no daily-loss limit of its own and says so — only the execution Bot&rsquo;s own daily-loss protection can cap losses. Exposure here is what the deployments are configured to spend, not a balance read from the exchange.</>],
                ["Honest unknowns", <><C>Healthy</C> appears only on positive evidence. <C>Unknown</C>, <C>No recent evidence</C>, <C>Not configured</C>, <C>Disabled</C> and <C>Not applicable</C> are real answers — an empty log is not proof that anything is working, and an unassessed feed is never reported as live.</>],
                ["Signal delivery", <>Whether the decisions this system produced are reaching the Bot: <C>healthy</C>, <C>idle</C>, <C>degraded</C>, <C>failing</C>, or <C>stalled</C>. Refusals by the Bot are counted separately from deliveries and are never folded into them.</>],
                ["Unresolved order intents", <>Orders whose outcome is unknown because the process died between sending and recording. The page says plainly that the order may or may not have been placed, and that each one should be reconciled against the Bot before resuming.</>],
              ]}
            />
            <Callout tone="critical" title="Halting does not close positions">
              <p>
                A halt refuses every emission, entries and exits alike. It cannot flatten
                a position, because this platform holds no credential and knows no fill
                price it did not produce. Close positions in the execution Bot or on the
                exchange.
              </p>
            </Callout>
          </Section>

          {/* ── 14 ── */}
          <Section id="research" title={SECTIONS[13]!.title}>
            <p>
              Two read-and-run surfaces sit beside the trading ones, and neither can
              place an order.
            </p>
            <Terms
              rows={[
                ["Backtests", <><A href="/backtests">Backtests</A> runs a strategy over history and lets you inspect every trade it took. A run is queued and polled to <C>done</C>; the window is labelled <C>Window (UTC)</C>, and its detail page has a <C>chart</C> tab and a <C>trades</C> tab. Above roughly forty markers the arrows keep their position and colour and drop their price labels — the Trades tab has every fill price.</>],
                ["Optimizers", <><A href="/optimizers">Optimizers</A> shows in-sample leaderboards beside the out-of-sample window each row was never fitted on. Read its own <C>How these numbers were produced — read before trusting one</C> card before acting on a row; it is opened for you the first time. A <C>FAILED</C> verdict means the edge did not survive on unseen data.</>],
                ["Where the research lives", <>The trees and the runs themselves belong to the Backtester, not to this application. If no research checkout is configured, Optimizers reports an empty registry rather than inventing one.</>],
              ]}
            />
          </Section>

          {/* ── 15 ── */}
          <Section id="safety" title={SECTIONS[14]!.title}>
            <ol className="space-y-3">
              {[
                [
                  "Spot only.",
                  <>There is no futures, leverage, margin or short selling in this product. The <C>Short position</C> drawing tool is a measuring annotation on the chart and is not an order of any kind.</>,
                ],
                [
                  "Paper is not Live.",
                  <>Paper proves signals. It proves nothing about fills, slippage or partial execution, and the Journal keeps the two sets of numbers apart.</>,
                ],
                [
                  "Heikin Ashi and Renko are display modes.",
                  <>Their prices never traded. No order, alert, strategy or backtest can see them.</>,
                ],
                [
                  "Know what the ticket is aimed at.",
                  <>The trading ticket names its instrument in its <C>Trading</C> strip. Focusing a different pane does not retarget it, and it will not quietly follow your eye.</>,
                ],
                [
                  "A refusal may be intentional.",
                  <>An operator halt, a risk limit, Shariah Mode and the Bot&rsquo;s own guards all decline orders by design, and each says which one it was.</>,
                ],
                [
                  "A missing update on screen is not proof that an order failed.",
                  <>The interface can lose its connection while the exchange is perfectly fine. Never resubmit on the strength of a screen that stopped updating: open the order&rsquo;s <C>Timeline</C>, check the <A href="/journal">Journal</A> and Operations&rsquo; delivery state, and if it is still unclear, check the exchange.</>,
                ],
              ].map(([lead, body], i) => (
                <li key={i} className="flex gap-3 rounded-lg border border-border bg-surface p-3">
                  <span aria-hidden="true" className="tabular shrink-0 text-sm font-semibold text-ink-faint">
                    {i + 1}
                  </span>
                  <p className="text-sm leading-6 text-ink-muted">
                    <strong className="text-ink">{lead}</strong> {body}
                  </p>
                </li>
              ))}
            </ol>
          </Section>

          {/* ── 16 ── */}
          <Section id="workflows" title={SECTIONS[15]!.title}>
            <div className="space-y-3">
              <Panel title="Inspect a coin">
                <Ol>
                  <li>Open <A href="/chart">Chart</A> and press <C>/</C>, or open <A href="/scanner">Scanner</A>, expand a row and choose <C>Open Chart</C>.</li>
                  <li>Pick a timeframe, and a layout if you want several timeframes side by side. Leave <C>Symbol</C> sync on so the panes follow one instrument.</li>
                  <li>Add studies from <C>Indicators</C>, and drawings from the tool rail. Drawings are per symbol, so every pane on that coin shows them.</li>
                  <li>Frame the span with the range shortcuts, and raise <C>History depth</C> if you need more bars than are loaded.</li>
                </Ol>
              </Panel>

              <Panel title="Paper-test a strategy">
                <Ol>
                  <li>Open <A href="/deployments">Live trading</A> and create a deployment for the symbol, timeframe and parameters you want.</li>
                  <li>Set <C>Delivery</C> to <C>Paper (simulate fills — no orders)</C>. It is created paused.</li>
                  <li>Activate it, acknowledging the dialog — which will state that fills are simulated and that no order is sent anywhere.</li>
                  <li>Let it run across the conditions you care about, then open <C>Paper results</C>.</li>
                  <li>Read it as evidence about signals. Fills are assumed at the bar close with no slippage, so it is not evidence about execution.</li>
                </Ol>
              </Panel>

              <Panel title="Place a manual Spot trade">
                <Ol>
                  <li>On the chart, focus the pane holding the instrument and open <C>Trade</C>.</li>
                  <li>Check the symbol in the ticket&rsquo;s <C>Trading</C> strip and the account in <C>Connected account</C>. That pair is what will be traded.</li>
                  <li>Choose the side, then <C>Market</C> or <C>Limit</C>. A BUY is sized in USDT; a SELL is sized in the coin.</li>
                  <li>Enter the amount, or use a percent button. Read the balances card and any sizing message beneath it.</li>
                  <li>Press <C>Review BUY</C> / <C>Review SELL</C>, read the confirmation, tick the real-funds acknowledgement if this is a mainnet account, and confirm.</li>
                  <li>Watch it in the <C>Orders</C> tab. Open its <C>Timeline</C> for the evidence behind it.</li>
                </Ol>
              </Panel>

              <Panel title="Create an alert">
                <Ol>
                  <li>For a price: the bell in the chart toolbar, a click on the price scale, or <C>+ Price</C> in the moving-average panel. For a moving average: the bell on that line. For support/resistance or a pivot: <C>Add level alert</C> on <A href="/alerts">Alerts</A>. For RSI or MACD: the oscillator rows in the same panel.</li>
                  <li>Set the condition and its timeframe.</li>
                  <li>Choose how often it may fire. <C>Once per bar close</C> reads completed candles only; the intrabar modes read a candle that has not finished, and the form says so.</li>
                  <li>Save it. It will notify you, and it will not trade.</li>
                </Ol>
              </Panel>

              <Panel title="Understand an order refusal">
                <Ol>
                  <li>Read the refusal itself, and the chip on the order row. It names its cause rather than reporting a generic failure.</li>
                  <li><C>Shariah policy</C> — the asset is not <C>ELIGIBLE</C>. Selling is still available, always.</li>
                  <li><C>Operator halt</C> or <C>Risk limit</C> — check <A href="/operations">Operations</A>. The halt banner carries the operator&rsquo;s written reason and the time.</li>
                  <li><C>The execution bot could not be reached</C> — nothing was sent and no order was placed. Check that the Bot is running and that this Platform points at it, then reopen the panel.</li>
                  <li><C>Exchange</C> or <C>Rejected</C> — the Bot or the exchange declined it, and their wording is the authority.</li>
                </Ol>
              </Panel>
            </div>
          </Section>

          {/* ── 17 ── */}
          <Section id="troubleshooting" title={SECTIONS[16]!.title}>
            <Terms
              rows={[
                ["A pane says reconnecting…", <>The live websocket dropped and is retrying on a bounded ladder (two seconds, doubling to thirty). The bars on screen stay correct; they simply are not streaming, and history still loads over the normal request path.</>],
                ["A pane says stream refused — trying another host…", <>Binance&rsquo;s stream host answered the connection with a refusal — on some networks <C>stream.binance.com</C> replies HTTP 451 — and the browser is switching to the other supported host, <C>data-stream.binance.vision</C>, Binance&rsquo;s market-data-only endpoint. This normally resolves within a second and the badge disappears.</>],
                ["A pane says live stream unavailable — history still updates", <>Both stream hosts refused the connection from this network. Candles keep loading and refreshing through this app&rsquo;s own server, and the watchlist shows the exchange&rsquo;s last quotes, but nothing on screen is streaming: do not read a price as current. Hover the badge for the hosts that refused. The browser keeps retrying; a network that reaches Binance, or a VPN, restores the stream without reloading.</>],
                ["A pane says feed stalled — price is not current", <>The connection is up but nothing has arrived for too long. Do not read the last price as current. It is being reopened.</>],
                ["A pane says not live, connecting…, or connected — waiting for data", <>Replay is on (no stream is attached), a stream is being established, or it is connected and no update has arrived yet. A quiet market can take a moment to send its first frame; the badge only claims <C>live</C> once one has.</>],
                ["The watchlist says Prices not streaming", <>The same situation as the pane badge, for the list: its quotes were read through this app&rsquo;s server when the list was opened and are real, but not moving. <C>Prices live</C> means frames are arriving.</>],
                ["A page shows an error instead of content", <>That is the page declining to guess. A screen that could not read something says so — for instance <C>Deployments could not be read, so this is not a statement that you have none.</C> — rather than rendering an empty state as though the question had been asked and answered.</>],
                ["The trading panel is unavailable", <>Three different situations, and the panel names which. <C>Manual trading is not enabled on this install</C> — this Platform will not send orders, and the chart, alerts and Journal are unaffected. <C>The execution bot could not be reached</C> — nothing was sent and no order was placed. <C>Manual trading is switched off</C> — the Bot itself reports order entry as disabled.</>],
                ["The Shariah console cannot read the Bot floor", <>It reports the floor as unknown, or says the enforcement state could not be read. Treat unknown as unknown, not as off.</>],
                ["A control did not take effect", <>On Operations, a failed halt or resume is reported as <C>That control did not take effect: …</C>, separately from a failed read, and stays until you dismiss it — so a status refresh cannot erase it.</>],
                ["The Scanner is unavailable", <>Its service is separate. The page says <C>Scanner service unavailable.</C> and offers <C>Retry</C>, rather than showing an empty table.</>],
                ["An order's state is unclear", <>Open its <C>Timeline</C>. Then check the <A href="/journal">Journal</A>, and Operations&rsquo; signal-delivery state — <C>stalled</C> specifically means an order may or may not have been placed, and the unresolved intents beneath it are where to look. Resubmitting is the one thing not to do first.</>],
              ]}
            />
            <Callout tone="caution" title="Where the truth lives when two screens disagree">
              <p>
                The exchange is the authority on what was filled. The execution Bot is
                the authority on what was sent. Trading Scene is the authority on what
                was decided. This application tells you what it knows, and leaves what it
                does not know marked as unknown rather than filling the gap in.
              </p>
            </Callout>
          </Section>

          <footer className="border-t border-border pt-4 text-xs leading-6 text-ink-faint">
            <p>
              This page describes the software. It is not financial advice, and it
              recommends no instrument, strategy or position.
            </p>
          </footer>
        </div>

        {/* ── Contents ── */}
        <nav aria-labelledby="toc-heading" className="min-w-0 lg:sticky lg:top-14">
          <h2
            id="toc-heading"
            className="text-xs font-semibold uppercase tracking-wide text-ink-faint"
          >
            On this page
          </h2>
          <ol className="mt-2 space-y-0.5 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
            {SECTIONS.map((section, i) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="flex gap-2 rounded-md px-2 py-1 text-[13px] leading-5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  <span aria-hidden="true" className="tabular text-ink-faint">{i + 1}.</span>
                  <span className="min-w-0">{section.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  );
}
