# Trading Scene — UI / UX contract

**This file documents current intent, not history.** It is the authority on how
Trading Scene looks and behaves. Where it and an older screenshot, an older
branch, an older comment or an older test disagree, this file and the current
production state win.

Written during TVP7 (September 2026), after every number below was measured
from the live products rather than inferred.

---

## 0. The regression rule — read this first

A recurring failure on this project is a later agent "tidying" the UI and
walking a considered decision backwards. Concretely, these have all happened
and must not happen again:

- the symbol control regressing to a canonical identity (`OANDA:EUR/USD · FX`,
  `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot`) instead of a ticker;
- selection painted in accent blue instead of the neutral state chip;
- the toolbar growing back to 42px, or menus back to 30px rows;
- provider/fixture error strings surfacing as primary page copy;
- typography drifting back to a 16px root with `text-xs` compensation;
- unique pages (Research, Shariah, Screener, Optimizer) drifting off the shared
  primitives because "they are not the chart".

**Do not revert a decision in this file because older code did it differently.**
If you believe a decision here is wrong, say so to the owner and get a
direction change. Otherwise treat it as settled.

Several of these rules have tests. See §9.

---

## 1. Product principle

Trading Scene is **one** premium workstation product.

1. For functionality Trading Scene and current TradingView genuinely share, we
   follow TradingView's **visual and interaction grammar** closely — density,
   typography, component shapes, placement, state behaviour. TradingView is a
   behavioural and visual reference only: we implement it ourselves and we do
   not copy proprietary assets or source.
2. Trading Scene-exclusive capability is **preserved and integrated**, never
   deleted to look more like the reference. It wears the same grammar.
3. Truthful provider, data and entitlement limits are **stated**, never hidden
   behind a control that appears to work.
4. Unique product pages keep their own information architecture and use the
   same design system. Research must not look like a candlestick chart; it must
   look like it was designed by the same team.

---

## 2. Tokens

All in `app/globals.css`. Components read them through the Tailwind names in
`tailwind.config.ts`; a colour is never typed as a literal twice.

### Dark (default)

| role | token | value |
|---|---|---|
| page frame / ground | `--ts-bg` | `#2e2e2e` |
| chrome + chart canvas | `--ts-surface` | `#0f0f0f` |
| raised panel | `--ts-surface-2` | `#1f1f1f` |
| popover / dialog | `--ts-popover` | `#1f1f1f` |
| hairline inside a panel | `--ts-line` | `#2e2e2e` |
| line that must read on the ground | `--ts-line-strong` | `#4a4a4a` |
| outlined form control | `--ts-control-border` | `#575757` |
| primary text | `--ts-ink` | `#dbdbdb` |
| **hover** | `--ts-state-hover` | `#2e2e2e` |
| **selected** | `--ts-state-active` | `#3d3d3d` |
| selected menu row | `--ts-menu-selected-bg` / `-ink` | `#f2f2f2` / `#0f0f0f` |

### Light — measured, not mirrored

Light is **not** a reflection of dark. Measured from the live reference:
chrome `#ffffff`, hover `#f2f2f2`, selected `#ebebeb`, separator `#ebebeb`,
ink `#0f0f0f`. An index-mirror of the dark ramp gives `#ebebeb`/`#dbdbdb`,
which is a visibly heavier chip than the reference's. If you change one theme,
**measure** the other; do not derive it.

### The canvas is themed too

lightweight-charts draws to a canvas, which cannot read a custom property, so
`lib/chartTheme.ts` holds the canvas's copy of the palette. That file is part
of the token system, not an exception to it, and it must read the document
rather than carry a second fixed palette:

| role | source |
|---|---|
| grid / crosshair / axis label / muted | `--ts-chart-*`, read per call |
| candle up / down | the user's `upColor` / `downColor` chart setting |
| volume bar | that same setting, **mixed toward `--ts-surface`** by `--ts-chart-volume-alpha` |

The volume weight is `0.28` dark and `0.5` light. It is a token per theme
because a bar that recedes properly on black disappears on white — the same
weight in both is the bug, not the fix. The light weight is measured:
`getImageData` over TradingView's own light volume band returns
rgb(131,204,192), which is their `#089981` at exactly half strength over white.

Two rules follow, and both have already been broken once:

1. **A canvas colour that should follow the theme is never a literal.** The
   volume pair used to be `#1c3a30` / `#3a1c24`, so light mode painted nearly
   black bars across a white chart and no amount of theme switching could
   reach them.
2. **A theme change must repaint the data, not just the options.** A histogram
   carries one colour per bar; `applyOptions` cannot recolour bars already
   drawn. `CandleChart` listens for `trading-scene-theme`, marks the main
   series dirty and takes its `replace` path.

When you touch either, verify by sampling the live canvas — read the tokens
off `document.documentElement` and the pixels out of `getImageData`. The
authored stylesheet is not what runs: `--ts-surface` is written `#ffffff` and
arrives as `#fff`, and the first version of this mix silently no-opped on it
while its unit test passed.

### The neutral rule

Every surface, border and muted label is **R = G = B**. Chromatic colour means
something in this product:

- `accent` — a primary action, a link, a focus ring, and data that is
  categorically "ours" (a paper-trading badge, a script kind).
- `up` / `down` — direction.
- `warn` — a state whose outcome is not yet known, and honest degradation.

**Accent is never "this one is selected."** That is what the two state
neutrals are for.

---

## 3. Density

Measured from live TradingView at 1440×900, DPR 1:

| thing | value |
|---|---|
| base type | **14px** (`--ts-workstation-font-size`) |
| chart leading | 1.35 (`.tv-workstation`) |
| app-page leading | 1.5 (`.ts-app`) |
| top toolbar row | **38px** |
| toolbar icon button | 38 × 38, icon 28 × 28, padding `0 5px` |
| toolbar caret (split-button half) | 24 × 38 |
| left drawing rail | 52px wide, glyph 28 × 28, corner caret 4 × 7 |
| right icon rail | 52px wide (matches the left) |
| right widget panel | 300px |
| toolbar separator | 1px × 22px on `--ts-line-strong`, 4px clearance each side |
| **dropdown** row | **40px**, inset 6px, radius 6px |
| **context menu** row | **32px** — a context menu is denser than a picker |
| watchlist row | 31px |
| dialog | 750px wide when `wide`, 20px/600 title, 50px form-row pitch |
| dialog form control | 34px tall, radius 6, 1px `--ts-control-border`, transparent |
| radius, everywhere | **6px** (`rounded-md`). `rounded-full` for pills only. |

Do not introduce a fourth radius or a third control height.

---

### One face, and where the other one is allowed

The product is set in the UI sans (`--ts-font-ui`). Monospace is a second
voice, and it says "this is machine text". It earns its place on:

- **code** — the Pine editor, the strategy input, the Shariah review JSON;
- **opaque machine identifiers** — a deployment id, a lease holder, a content
  hash, an exchange order id, an issue code.

It does **not** earn its place on prose, on a name, or on a number. A figure
that needs to line up in a column gets `.tabular`
(`font-variant-numeric: tabular-nums`) on the product's own face — that is the
whole job monospace was being used for, done without changing what the product
sounds like.

Both halves had drifted. The Journal set nine figures in a typewriter face, so
its headline P&L read as a code token and the "Unknown" beside it read as a
literal; the Screener and Research printed service error SENTENCES in it,
which is prose wearing the costume of a stack trace. The allowed list is
enumerated in `tests/uiContract.test.ts`, so adding to it is a decision rather
than a drift.

---

## 4. Interaction grammar

### `.tvc-control` — the one state primitive

A chrome control is **transparent**. Hover and selection are painted by a
`::before` chip inset 2px with a 6px radius. Two consequences, both deliberate:

- A full-bleed tint on a 38px button butts against its neighbour, so running
  the pointer along a row drags one continuous block of grey and no single
  control resolves. Two pixels of inset keeps them discrete.
- The hit zone stays 38px while the visible chip is 34 — a bigger target than
  it looks, which is the right way round.

**Selection is declared, not styled.** The chip is driven by `aria-pressed`,
`aria-checked`, `aria-selected`, `aria-expanded` or `data-active`. A control
cannot look active while announcing that it is not. If you are writing a
ternary that swaps a background class for "selected", you are doing it wrong.

### `.tvc-menu` / `.tvc-menu-row` / `.tvc-menu-sep`

Every dropdown, flyout and context menu. Popover `--ts-popover` at radius 6
with `--ts-popover-shadow` and no border; rows 40px inset 6px; a **selected
row is an inverted chip** (`--ts-menu-selected-bg` on `-ink`), not a tint.

Both `.tv-workstation` and `.ts-app` are inside this grammar — see the
`:is(…)` guards in `globals.css`. A button must not hover differently
depending on which page it is on.

### Focus

`:focus-visible` only, 2px accent outline, 1px offset inside the workstation.
The focus rule must **not** set `border-radius` — that rewrites the element's
own radius while focused, which squared off the symbol pill.

A dialog gives focus to its **panel**, not to its first focusable. The close
button is first in DOM order, so focusing it drew a bright ring around "cancel
this" on every dialog open and put the keyboard's first stop on the wrong
control.

---

## 5. Symbol display policy

There are four different things and they go in four different places.

| what | where it belongs | example |
|---|---|---|
| **ticker** — `displayTicker()` | toolbar pill, pane legend, watchlist row | `BTC/USDT` |
| **venue** — `displayVenue()` | status line, muted, after the interval | `· Binance` |
| **asset type** | a badge, and only when it is NOT spot | `PERP`, `FX` |
| **canonical identity** — `displaySymbol()`, the raw `instrument:v1:…` | tooltips, the symbol dialog, Chart Settings' Instrument block, exports, support | `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot` |

**Primary chrome never shows a canonical or debug string.** The toolbar pill
showing `OANDA:EUR/USD · FX` and Chart Settings printing
`instrument:v1:BINANCE:spot:…` at the user are the two regressions this rule
exists to prevent. Nothing is hidden — the technical form is one hover away.

The same rule governs failures: a provider's raw message, a route path, a
status code or a stack frame is **never the headline**. Say what it means for
the reader, put the cause in the tooltip. See `shortReason` in
`app/shariah/page.tsx` and `errorDetail`/`errorLevel` in `lib/useCandleHistory`.

Degraded ≠ broken. A feed that has fallen back to polling is the chart still
working: amber chip over the plot. A chart you cannot trust costs a row.

---

## 6. Settings

Three separate concepts, three separate surfaces, never one generic shell:

- **Chart settings** — `ChartSettingsModal`, the pane's own `ChartSettings`.
- **Indicator settings** — `NativeStudySettings` (built-ins) / the panel (Pine).
- **Drawing settings** — `DrawingSettingsModal`.
- **Chart-type parameters** — filed under the Symbol tab, beside the chart type
  that owns them. Not under "Canvas", which is about the drawing surface.

**A control that moves nothing must not exist.** If the engine cannot honour
it, leave it out and say why in a comment — `lockPriceToBarRatio` and
`noOverlappingLabels` are absent for exactly this reason. If the capability
exists and the control does not, add the control.

Conversely: if a control renders, it must reach the object it names. Body /
Borders / Wick appear only for presentations that have them; a study pane's
eye and trash resolve to the API that owns the study.

---

## 7. Unique product pages

Research, Shariah, Screener, Optimizer, Trading, Alerts, Journal, Operations,
Getting started use the **same** design system and keep their own information
architecture.

Shared primitives live in `components/ui.tsx`: `PageShell`, `PageHeader`,
`Card`, `CardHeader`, `Button`, `IconButton`, `Field`, `TextInput`, `Select`,
`Textarea`, `Empty`, `Loading`, `Notice`, `StatusBadge`, `Separator`.
`components/Modal.tsx` is the only dialog. Reach for these before writing a
class string.

Two habits to preserve because they are product meaning, not styling:

- **"could not read" ≠ "you have none."** `Empty`, `Loading` and `Notice` take
  the copy from the caller precisely so this distinction survives adoption.
- **The Screener's `.dense` table** is a justified different density: thirty
  columns earns it. Do not normalise it to 31px rows.

---

## 8. TradingView reference rule

Do **not** copy proprietary TradingView SVGs, source or private implementation
detail. Do implement our own reusable version of the observed grammar, using
our own geometry or legally appropriate open-source icons with similar
functional silhouettes.

Measurements of a public product's rendered geometry are observations, and
they belong in `docs/` and in comments so the next agent does not have to
re-derive them.

---

## 8b. Numerical and interaction parity — how they were established

Two things a screenshot cannot tell you, both measured against the live
reference rather than argued from first principles.

**The arithmetic.** Given the same bars, this engine produces the same numbers
as TradingView. Eleven values at one bar of BINANCE:BTCUSDT 4h — RSI, EMA at
four lengths, MACD line/signal/histogram, Bollinger basis/upper/lower, ADX and
session VWAP — agree to a worst relative difference of 4.8e-13. The right-hand
side was read out of TradingView's own study models (`metaInfo()` for plot
titles, `properties().inputs` for the parameters it was ACTUALLY using, `data()`
for its computed value per bar), and the bars were proven identical before any
indicator was compared. `tests/tradingViewNumericParity.test.ts` pins it with a
committed fixture, so it is reproducible and hermetic.

If you change anything in `lib/ta/core.ts`, that test is the one that decides
whether you changed a method or only a sum.

**The feel.** Measured in a browser on a PRODUCTION build — the distinction
matters, because `reactStrictMode` double-invokes effects in development and a
dev-only doubled subscribe is not a defect. Every interaction in the
workstation completes in 25–44ms with zero chart remounts and zero new sockets:
theme, chart type, timeframe, settings, indicator add/remove, drawing tool,
rail panel, replay, bottom panel, pan, zoom, resize. A timeframe change costs
exactly three requests, each once.

Two structural facts hold that up, and both are one careless dependency away
from being lost — §9 has the test:

- the chart is created in an effect with **no dependencies**, so nothing can
  recreate it;
- the market feed subscribes on WHAT is watched, never on how it is drawn. A
  colour in that dependency array re-opens a websocket every time the user
  changes a candle colour or flips the theme.

---

## 9. What is protected by tests

| rule | test |
|---|---|
| every colour token a component uses is declared | `tests/theme.test.ts` |
| the canvas follows the theme: no fixed volume palette, both themes state a weight, the mix matches TradingView's measured bar, shorthand hex included | `tests/uiContract.test.ts` |
| the indicator engine agrees with TradingView's own numbers on identical bars | `tests/tradingViewNumericParity.test.ts` |
| presentation never re-subscribes the feed or remounts the chart | `tests/uiContract.test.ts` |
| a symbol reaches the user through displayTicker/displaySymbol, never raw | `tests/uiContract.test.ts` |
| accent in a conditional is a defect unless marked `accent-is-meaning` | `tests/uiContract.test.ts` |
| every icon-only rail control has an accessible name, not only a tooltip | `tests/drawingRail.test.ts` |
| monospace appears only on code and machine identifiers; the Journal's figures use `.tabular` | `tests/uiContract.test.ts` |
| the phone action bar's height is one token; the theme toggle clears it | `tests/uiContract.test.ts` |
| a legend clips rather than wraps, collapsed and expanded alike | `tests/uiContract.test.ts` |
| a transient notice never sits on the permanent pane legend | `tests/uiContract.test.ts` |
| every drawing tool is reachable from exactly one rail group; group ids are the reference's; no group deeper than 20; every icon key exists | `tests/drawingRail.test.ts` |
| the toolbar's control registry and tier assignment | `tests/chartToolbar.test.ts` |
| chart-type list, order, and settings-driven transform parameters | `tests/chartType.test.ts` |
| chart settings normalise, clamp and migrate | `tests/chartSettings.test.ts` |
| the pane legend shows a ticker, not a canonical id; no duplicated close | `tests/chartWorkspace.test.ts` |
| every popover goes through the exclusive-popover registry | `tests/powerUx.test.ts` |
| failures are announced, toned, and never print the raw cause | `tests/renderedUx.test.ts` |
| chart settings reach the pane; Cancel undoes the whole visit | `tests/dom/chartShell.test.tsx` |
| the workstation's symbol/interval controls exist exactly once | `tests/dom/shellDensity.test.tsx` |

Add to this table when you add a rule worth protecting. Prefer semantic DOM
assertions; do not snapshot pixels, and do not pin a Tailwind class string as a
proxy for a behaviour — that makes a CSS snapshot wearing a behaviour's name,
and it fails for reasons unrelated to what it is called.
