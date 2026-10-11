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
| right icon rail | **46px** wide, 46×46 cells, 38×38 chip (`[data-side-rail] .tvc-control::before { inset: 4px }`), 20px glyphs at stroke 1.5 — measured on the reference 2026-09-14 |
| right widget panel | 300px |
| toolbar separator | 1px × 22px on `--ts-line-strong`, 4px clearance each side |
| **dropdown** row | **40px**, inset 6px, radius 6px |
| **context menu** row | **32px** — a context menu is denser than a picker |
| watchlist row | **30px** on `18px minmax(52px,1fr) minmax(0,84px) minmax(0,64px) minmax(0,60px)` with an 8px `column-gap` (TVP8 F-01); 46px title row, 29px column row, 36px section header; the panel keeps a 4px `--ts-line` gutter inside its 300px |
| dialog | 750px wide when `wide`, 20px/600 title, 50px form-row pitch |
| dialog form control | 34px tall, radius 6, 1px `--ts-control-border`, transparent |
| settings-dialog checkbox | **18px**, radius 3, 34px hit area, 10px gap before the label; checked is a light fill with a dark check — never `accent` |
| settings-dialog swatch | **34 × 34**, 24px inner colour, radius 6 |
| settings-dialog line-style button | **75 × 34** — colour square plus a preview of the line |
| settings-dialog number field | **70 × 28**, tabular, the unit as 14px muted text AFTER the field |
| radius, everywhere | **6px** (`rounded-md`). `rounded-full` for pills only. |

The 34px rule is for buttons and dropdowns. A settings-dialog NUMBER field is
28px and a checkbox is 18px: both measured on the reference, and neither is a
fourth control height — they are a field and a box, not buttons.

Do not introduce a fourth radius or a third control height.

---

### Chrome does not float

Nothing in the shell is `position: fixed` over the workspace. The theme toggle
was, for a while — blurred, drop-shadowed, 10px radius, bottom-right of every
page, on top of the price axis — and it was the first thing an experienced
TradingView user noticed, before touching a control. No workstation floats a
chrome control over its own canvas.

There is always somewhere for it to go: the chart has `ProductMenu` and every
other page has `Nav`'s control row. Put it there.

### One button, one field, one row

Three primitives, and the rule for each is that a second definition is a bug:

- `Button` in `components/ui.tsx` — 34px, radius 6, an outline on a transparent
  ground. There were three Cancel buttons in three dialogs at three heights.
- `FIELD`, same file, exported — thirteen files had retyped the string it
  replaces. Notice PANELS are a different thing and keep `bg-surface-2`.
- `.tvc-menu-row` — a popover that adopts `.tvc-menu` adopts the row too. Half
  the grammar looks more wrong than none, because the padding is right and the
  rhythm is not.

Icons are drawn, never typed. `×`, `▼` and a fullwidth `＋` were scattered
across six controls; `CloseGlyph`, `CaretGlyph` and `PlusGlyph` exist so the
seventh is an import.

**The settings-dialog primitives (TVP8, R6).** A dialog full of native
`<select>`s and `<input type="color">`s reads as a different product: the OS
draws the chevron, the OS draws the popup, and the well is the wrong size.
Five more primitives live in `components/ui.tsx` for that reason, and a second
definition of any of them is a bug:

- `Checkbox` — 18px box, 34px hit area, label supplied for the accessible name.
- `Dropdown` — a `.tvc-control` button plus a `.tvc-menu` listbox at 100 / 150
  / 180 wide. **No native `<select>` inside a dialog.**
- `Swatch` — 34 × 34, opening a palette whose first cell is `Theme` (writes
  `""`, meaning "the token decides") and whose last is the custom `+` over the
  native colour input, so keyboard reach is kept. The palette is the
  reference's: ten neutrals, ten hues, six rows of tints (18px cells, 23px
  pitch). `allowOpacity` adds its `Opacity` slider and stores `#rrggbbaa`
  (`lib/colorAlpha`) — on for drawings, whose canvas reads eight digits; off
  for chart settings and Pine inputs, whose consumers do not (W2A-06).
- `LineStyleButton` — 75 × 34, popover of palette + width 1–4 + Solid / Dotted
  / Dashed. `WidthPicker` / `DashPicker` behind a trigger of their own (the
  drawing toolbar) take `layout="list"`: labelled 32px rows (`1px`…`4px`;
  `Line` / `Dashed line` / `Dotted line`), the current one on the selected chip.
- The selected drawing's floating toolbar (W2A-05) is the reference's widget
  grammar: a 24px drag handle, icon-only 38 × 38 widgets with 28px ink glyphs,
  colour as a mark over a bar of the colour, width as `— 2px`, no carets. It
  never covers its drawing or the legend column (`lib/drawingToolbarPlacement`),
  stacks above the legend (`z-30`), and a dragged position is kept for the tab.
  `Template` opens the template menu (Save Drawing Template As… / Apply Default
  Drawing Template / this tool's saved ones), never the settings dialog.
  **The widget set is the tool's** (M1 / F-10, measured on Premium): a line is
  drag · Template · Line colour · (Text colour, once it has text) · Width ·
  Style · per-tool controls (Fill, AVWAP bands, profile) · Settings · Lock ·
  Delete · More; a text-carrying tool (Text, Note, Comment, Callout, Price
  note, Signpost, Flag) is drag · Template · (Line colour — not on the plain
  Text, which is nothing but its text) · Text colour · font size (`14`, a
  32px-row list of 10 11 12 14 16 20 24 28 32 40, shared with the Text tab) ·
  Settings · Lock · Delete · More. **Clone and Hide are not on the bar** —
  the reference's has neither; they are in More and the right-click menu.
  Premium's `Add alert` is offered only where an alert can be made, so a
  sloped drawing has no dead alert widget.
- **Text is typed on the chart** (M1 / F-01). A click with a text-carrying
  tool places the drawing at the click (a new one at 14px) and opens an
  inline editor over the canvas at its anchor, in the drawing's own face,
  size and text colour, with the floating toolbar beside it — never a modal.
  Enter, a blur or a click anywhere else commits; Shift+Enter is a new line;
  Escape cancels (a fresh drawing is taken away again). An empty `Text` is
  removed. Placing and typing is ONE undo step, and a cancelled placement is
  none. Double-clicking an existing text edits it inline the same way (a
  locked one opens its settings, as every other drawing's double-click does);
  the full options stay behind the toolbar's gear. The editor owns its keys
  (`data-owns-keys`): no keystroke typed into it reaches a chart shortcut.
- `NumberField` — 70 × 28 tabular with the unit beside it.

`Button` gains one variant: **`contrast`** — a light fill with dark text, for a
dialog's CONFIRMING action (`Ok`). It is not `primary`: accent is a primary
action elsewhere in the product and §2's neutral rule keeps it that way, and
the reference's own dialog confirms in a light-filled button rather than a
blue one. `Cancel` beside it stays a ghost.

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

**A checked toggle is not a selected row.** Selection in a list — the interval
you are on, the chart type, a filter value — is the inverted chip. A checkbox
or radio row (`Auto (fits data to screen)`, `Regular`, `Compact list`) and a
switch row (`Autosave`) state themselves with a ✓ in the mark column or with
the switch's track, and take **no fill**: measured on live Premium's
price-axis and Manage layouts menus (2026-10-11), where `Auto ✓` and
`Regular ✓` are both plain rows. One paint for both facts made the axis menu
open with two rows that each looked selected. A row that draws its own mark
carries `data-check-mark` (or is `role="switch"`) and `globals.css` excludes
it from the chip; a row whose fill is its only mark keeps it.

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
| **ticker** — `displayTicker()` | toolbar pill, pane legend, watchlist row | `BTCUSDT` (no slash — §5b) |
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


### 5b. The ticker's form (TVP8, owner veto OV-B / R1-08)

`displayTicker` writes a ticker the way the venue lists it and the reference
shows it: `BTCUSDT`, `EURUSD`, `AAPL`, `SPX` — no slash. A perpetual keeps the
reference's `.P` suffix (`BTCUSD.P`); a dated series keeps its expiry. The
slashed pair (`BTC/USDT`) was one of the strongest first-glance tells in the
owner's screenshots, in the symbol pill and in every watchlist row. The long
form — venue, pair and product type — stays in `displaySymbol`, for tooltips,
dialogs and status lines.

## 6. Settings

Three separate concepts, three separate surfaces, never one generic shell:

- **Chart settings** — `ChartSettingsModal`, the pane's own `ChartSettings`.
- **Indicator settings** — one dialog family for every study, as on Premium:
  `NativeStudySettings` (built-ins: Inputs / Style / Visibility) and
  `PineStudySettings` beside it (Pine: Inputs from the script's `input()`s,
  grouped by `group=`; Style and Visibility absent because nothing stores a
  Pine plot override or timeframe allow-list). The Indicators panel's inline
  form is a secondary path, never where the gear lands.
- **Drawing settings** — `DrawingSettingsModal`.
- **Chart-type parameters** — filed under the Symbol tab, beside the chart type
  that owns them. Not under "Canvas", which is about the drawing surface.

**A control that moves nothing must not exist.** If the engine cannot honour
it, leave it out and say why in a comment — `lockPriceToBarRatio` is absent
for exactly this reason. If the capability exists and the control does not,
add the control. (`No overlapping labels` was once listed beside it; it is the
library's own `alignLabels` on both price scales and has a test — F-15.)

Conversely: if a control renders, it must reach the object it names. Body /
Borders / Wick appear only for presentations that have them; a study pane's
eye and trash resolve to the API that owns the study. A row whose datum is
PROVIDER-dependent appears only once the pane has that datum — `Bid and ask`
is rendered only after this instrument's ticker has reported a quote.

### 6a. What the Chart settings dialog deliberately omits (TVP8, R6)

The reference has rows this product cannot honour. None of them is drawn
greyed out; they are simply absent, and this is the list so that adding one
back is a decision rather than a drift:

- **Status line** — `Logo` (no instrument-logo pipeline), `Open market status`
  (no market-hours model; the feed-state pill is a different fact),
  `Buy/sell buttons` (no on-chart order entry), indicator `Background` and its
  opacity slider (the legend's ground is a token, and this dialog has no
  slider control type).
- **Scales and lines** — `Currency and Unit`, `Value according to scale` and
  `Lock price to bar ratio` (lightweight-charts 4.2 exposes no equivalent).
  NOT omitted, and verified to move the chart (F-15, 2026-10-11): `No
  overlapping labels` (the price scales' `alignLabels`) and `Countdown to bar
  close` (the last-price plate's countdown row), both pinned in
  `tests/dom/chartSettingsApply.test.tsx`. This list named them as absent
  long after they shipped; `Plus button`, `Previous day close` and `High and
  low` are dialog rows too and are not omissions either.
- **Canvas** — `Pane separators` (a theme token), the `BUTTONS` section
  (`Navigation`, `Pane`: no navigation overlay).
- **Trading** — `Buy/sell buttons`, `One-click trading`, `Execution sound`,
  `Show only rejection notifications`, `Reverse position button`, `Project
  order for market orders`, `Brackets`, order/position alignment, trades in
  snapshots. Money / Pips / % sub-rows are omitted too: the ticket reports in
  money and a pip has no meaning on a crypto pair.
- **Alerts** — the `NOTIFICATIONS` section (`Alert volume`: no sound;
  `Automatically hide toasts`: a workspace preference, not a pane setting).
- **Events** — `Ideas`, `Economic events`, `Latest news`, `News notification`
  (no such provider), `Session breaks` (no vertical session primitive).

Two are recorded as follow-ups rather than omissions, because the engine can
do them and only the plumbing is missing: `Color bars based on previous close`
(per-bar `color`/`borderColor`/`wickColor` on every candle write path) and a
per-chart timezone (`lib/chartClock` is UTC throughout, which is why the
`Timezone` row is a static value with a note rather than a one-option
dropdown).

---

## 7. Unique product pages

These pages use the **same** design system and keep their own information
architecture. Adoption is not uniform, and this section states where it is not
rather than implying otherwise:

| page | shell | notes |
|---|---|---|
| Research, Shariah, Trading, Alerts, Journal | `PageShell` | the five that adopted it; Research uses `PageHeader` |
| Screener | its own `.scanner-workspace` | a full-bleed grid with a header of live filters, not a page title; `PageShell` would box it |
| Optimizer, Operations, Getting started | hand-rolled `max-w-[1400px] px-4 py-6` | the same measurements `PageShell` applies, not yet the same component |

The last row is an honest gap, not a decision. It was written here as done
before it was, which is how it survived: a contract that describes an intention
as a fact stops anyone checking.

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

## 7b. Visual parity is a live-pair judgement — the owner's veto (TVP8)

On 2026-09-13 the owner compared the live products side by side and vetoed
the shared surfaces as visibly non-matching, after several campaigns had
reported them matched. The reports were not lying about what they measured;
they were measuring the wrong thing. This section exists so that never
recurs.

For every surface Trading Scene SHARES with TradingView — the top toolbar,
the left drawing rail, symbol search, the indicator browser, indicator pane
headers, the chart-type menu, chart settings, the bottom range row, the
watchlist and its details, the account/product menu, shared dialogs and
context menus, dark and light, desktop and phone:

- **feature existence is not parity** — 87 drawing tools in the product do
  not make the rail match; the rail's top-level cells, order, gaps, flyout
  affordance and flyout contents do;
- **matching dimensions is not parity** — a 38px row with a different
  composition is a different toolbar;
- **matching names is not parity** — seven settings tabs with the
  reference's names and different contents are a different dialog;
- **functional equivalence is not parity** — a browser that finds the same
  indicators through a different information architecture is a different
  product.

A shared surface is at parity only through: a CURRENT live TradingView
capture, a CURRENT Trading Scene capture of the same state (viewport, theme,
symbol, timeframe, panel, dialog, tab), an explicit pair review by an
independent reviewer, the repair, and a fresh after-review — twice, for the
high-value surfaces. If a reviewer can still say "this one is obviously
Trading Scene because of the shared UI", it is not done. Branding may reveal
identity; shared grammar may not.

Trading Scene-exclusive capability is kept and integrated in the same
grammar; provider truth is never hidden; technical detail (identity strings,
provider diagnostics, bar counts, build ids) belongs in tooltips, Details,
diagnostics and status surfaces — never in the shared primary chrome.

The live ledger is `TradingView-Parity-TVP8-20260913/00_VISUAL_PAIR_MATRIX.md`;
the veto itself is `00_OWNER_VISUAL_VETO.md`; the atomic inventories are
`00_TOP_TOOLBAR_MATRIX.md` and `00_LEFT_RAIL_MATRIX.md`. The left-rail
grouping contract and the symbol-search / indicator-browser architecture are
recorded below in §7c once finalised, and are not to be "tidied" back.

### 7b-i. The shell and the toolbar (TVP8 batch A — measured 2026-09-14)

- The toolbar is the workstation's FIRST FULL-WIDTH ROW: `[52×38 account
  cell][toolbar]`, above the left rail, the chart column, the side panel and
  the right rail, which share the second row. Nothing narrows the row; the
  watchlist header never sits in the toolbar band. Tests:
  `tests/chartToolbar.test.ts` ("first full-width row").
- Primary-row order is the reference's and is the registry's order in
  `lib/toolbarLayout.ts`: symbol pill · compare │ interval favourites +
  24px caret │ style favourites (icon radios) + 24px caret │ indicators │
  alert · replay │ undo · redo … layout · saved-layout name + cloud + caret ·
  sync (≥2 panes only) │ quick search · settings · fullscreen · snapshot ·
  more · **Trade** pill. Every control is icon-only at every width; the only
  words on the row are the ticker, the chips, the layout name and `Trade`.
  No readout (`Last close`, bar counts) and no text labels ever return to the
  row; the bar count is the History-depth group's tooltip in the secondary
  strip.
- **Overflow is progressive** (A13 / B-05, October 2026). Each control leaves
  the row on its own, lowest priority first — quick search, fullscreen,
  undo/redo, indicator templates, alert and replay, the layout name and sync,
  the layout grid, snapshot, settings, Trade, indicators; Compare at `sm` —
  at the widths in `lib/toolbarLayout.TOOLBAR_OVERFLOW_FROM`, and from then on
  is a labelled row of the **⋯ dropdown**. Premium at 1200 keeps Layout, the
  name, Settings, Snapshot and Trade on the row, and so do we. ⋯ is on the
  row at every width and opens that dropdown — never a second row; the
  secondary strip (History · Overlays · Automate · Strategy · Best config) is
  opened by its own named row at the bottom of the dropdown. A control is on
  the row or in ⋯ at every width, never both, never neither, and the row fits
  the viewport from 640 to 1440 (`tests/chartToolbar.test.ts` sweeps it).
- Interval chips print day-and-longer resolutions uppercase (`1D`) and
  sub-day lowercase (`4h`); the chip carries the canonical id in
  `data-resolution`. The favourites strip never clips at ≥ `sm`.
- Toolbar glyphs: 22px optical size, stroke 1.6, round caps
  (`TOOL_ICON_SIZE`, `TOOL_ICON_STROKE`), our own silhouettes.
- The account entry is a 52×38 cell with a 28px avatar (initial) and a
  10px status badge; its menu is 260px at `left-[52px] top-0`, 40px rows,
  14px/400 labels, a 28px glyph column, hairline-in-13px separators, switch
  rows for settings, `Sign out` last in `text-down`; one 32px `role="status"`
  row carries the stream/health truth — never a paragraph.
- The bottom row is `1D 5D 1M 3M 6M YTD 1Y 5Y All` — all nine, always, the
  unreachable ones DISABLED — then a hairline and a one-click go-to-date
  button, with the clock (13px muted, `hh:mm:ss UTC`) at the right. With more
  than one chart on screen there is ONE such row under the whole layout,
  acting on the focused chart (the focused pane renders its own row into the
  workspace's host), never one per pane (C11). The price
  scale's controls live at the foot of the price axis as the reference's
  chips — 20 × 22, the letter at weight 400 (F-11) — `A` (auto) and `L`
  (log) side by side, with `%` beside them
  and `reset` above while there is something to undo; an ON chip is the
  inverted chip (`[data-axis-chip]`). They reveal while the pointer is
  ANYWHERE on the axis, not only over their own box (W2A-02); a non-price
  scale mode still declares itself. The axis `⊕` sits on the plot side of the
  chart/axis boundary at the crosshair's price, never over a tick or the
  crosshair's label (W2A-01, `tests/dom/axisPlusButton.test.tsx`).

### 7b-ii. The chart's own surfaces (M2, measured on live Premium 2026-10-11)

- **The series legend's hover cluster covers nothing** (F-02). `Flag` and
  `More` (28 × 22 each) are zero-width at rest and, on hover or focus, take
  their width IN FLOW as the last item of the identity row — after the
  title, interval, venue and the `vs …` chip, none of which moves. The values
  that follow shift right by the cluster's width (or wrap, as they already do
  in a narrow pane). It used to be a zero-width overlay that painted over the
  open price; Premium never covers a value.
- **The time-axis crosshair label says when** (F-03): `Sun 04 Oct '26 20:00`
  below one day, `Sun 04 Oct '26` at 1D and up — the weekday per `Day of week
  on labels`, the date per `Date format`, the time per `Time hours format`,
  in the chart's zone (`crosshairTimeFormatter`). The library sizes the label
  to its text.
- **A study pane has ONE pane control** (F-04): a 24 × 24 bordered `⋯` in ink
  rgb(219), 4px left of the price axis, opening `Manage panes` — Maximize
  pane (`Double click`) · Collapse pane (`⌘ Double click`) · Move pane up ·
  Move pane down · Delete pane — on the shared 32px context-menu rows. A move
  at the end of the stack is DISABLED, not dropped. Double-click on the
  pane's plot maximises/restores it; ⌘/Ctrl double-click collapses/expands.
  A collapsed pane holds its 24px (it never shrinks under the stack cap) and
  its control paints above every resize grip (B-02).
- **Every menu row mark is an 18px glyph in a 28px box** (W2A-07, F-05),
  including Manage layouts, whose row actions use the same 28 / 18; and a
  favourite star is 18px in a 24px box in the interval and chart-type menus.
  `MenuMark`, `MenuGlyphIcon`, `MenuStarGlyph` in `components/tv/ContextMenu`
  are the one definition.
- **Indicator templates** (F-06) is `Save indicator template…` · `Open
  template…`, 32px rows with marks, 219 wide; the saved and default templates
  are in the `Open template…` dialog.
- **The last-price countdown** (F-07) is `mm:ss` under an hour (`49:20`) and
  `hh:mm:ss` from an hour; the day form is unverified and stays `hh:mm:ss`.
- **The chart menu offers `Remove N drawings`** beside `Remove N indicators`
  (F-08), with no confirmation; the drawing history makes it one Undo step.
- **Compare** (F-09): the toolbar ＋ always opens the Compare dialog; the mode
  menu is the `vs …` chip's (§7c-ii). A pane switched to the instrument it
  was compared with drops the comparison.
- **The chart-type menu** (F-12) is Premium's full-height column from the
  viewport top (273 × 900 at y=0), as the interval menu is.

### 7c. Left-rail grouping contract (TVP8, measured 2026-09-14)

The rail is 52px wide with 52×38 cells starting at y=48, in exactly this
order: eight tool groups — Cursors (Cross), Trend tools (Trendline), Gann
and Fibonacci (Fib retracement), Patterns (XABCD), Forecasting and
measurement (Long position), Geometric shapes (Brush), Annotation (Text),
Icons (Icon) — a gap, Measure and Zoom in as single cells, a gap, Magnet
(weak/strong flyout), Keep drawing, Lock (scope flyout), Hide (scope flyout),
a gap, Remove (scope flyout). Gaps are 13px with a centred 1×36px
`--ts-rail-separator` hairline. Each group's flyout has TradingView's
sections, member order, sentence-case labels, `kbd` chords (⌥T ⌥H ⌥J ⌥V ⌥C
⌥F ⌥⇧R) and a hover star; it opens at x=53, 6px above its cell, at content
width, with 40px tool rows and 32px option rows. The caret is an 11×34
hover-revealed edge strip, never a corner triangle. Glyphs are our own, one
silhouette per tool, full ink at rest.

#### 7c-i. The keyboard: a bare letter is the SYMBOL (TVP8 R4b-05, measured 2026-09-14)

Reference: `TradingView-Parity-TVP8-20260913/measurements/tv-keyboard-shortcuts-20260914.md`.

TradingView spends the whole alphabet on one thing — "Change symbol: any
letter" — and puts the drawing tools on ⌥-chords. Trading Scene did the
opposite: eleven bare letters were tools, and a letter typed over the chart
armed one instead of opening the symbol search. The owner's endgame rule is
that live TradingView is the spec for a shared surface, so:

- **A bare printable letter, with no modifier, focus not in a field and no
  dialog open, opens the symbol search with that letter already in the box**,
  caret at the end, nothing selected. `app/chart/page.tsx` owns that listener,
  in the capture phase, and it consults `resolveShortcut` rather than a second
  copy of the table — so a letter the table still claims (⇧F) keeps its
  meaning, and a letter continuing a half-typed interval (`4`,`h`) belongs to
  the interval.
- **Any number key is the interval**, as it already was (`15` Enter → 15m).
- **The reference's chords, exactly**: ⌥T trendline · ⌥H horizontal line ·
  ⌥J horizontal ray · ⌥V vertical line · ⌥C crossline · ⌥F fib retracement ·
  ⇧⌥R rectangle · ⌘⌥H hide drawings · ⌥R reset view · ⌥L log scale ·
  ⇧F fullscreen · ⌘K quick search · `/` indicators · ⌘, chart settings ·
  ⌘/ keyboard shortcuts · ⌥⌘S save chart image · ⇧⌘S copy chart image ·
  ⌘Z / ⌘⇧Z / ⌘Y undo and redo · ⌘C / ⌘V / Delete on a drawing.
- **Trading Scene's own actions keep their letter under ⌥** — ⌥X text,
  ⌥M magnet, ⌥B Bar Replay — and the three whose same-letter ⌥ chord the
  reference has already spent take one more modifier rather than a chord that
  means something else to a user arriving from it: ⇧⌥D stay in drawing mode
  (⌥D is TradingView's data window), ⇧⌥L lock drawings (⌥L is log scale),
  ⇧⌥P bottom panel (⌥P is percent scale).
- **Not yet implemented, and therefore not advertised**: ⌥A add alert, ⌥G go
  to date, ⌥I invert scale, ⌥P percent scale, ⌥W add to watchlist, `.` load
  layout, ⌘S save layout (the saved-layout hook owns ⌘S already but it is not
  in `BINDINGS`), ⌥D data window, ⌥N text note. A chord with no action behind
  it is never printed on a cap.
- `lib/shortcuts.ts` `BINDINGS` is the single table; the rail's flyout caps,
  the shortcuts sheet and the command palette all read it, so a printed cap is
  a chord that works. Tests: `tests/powerUx.test.ts`,
  `tests/dom/keyboard.test.tsx`, `tests/dom/typeToSearch.test.tsx`.

#### 7c-ii. The symbol search, and Compare (TVP8 R4b, measured 2026-09-14)

Reference: `measurements/tv-symbol-search-20260914.md` and
`tradingview/symbol-search-*-1440-dark.png`.

- The panel is `[300,110,840,680]`, radius 6, on `--ts-popover` with
  `--ts-popover-shadow` applied as a STYLE (the arbitrary-value Tailwind
  shadow utility does not resolve). Bands: 68px header · 40px box · 28px chip
  row · 24px dropdown row · 40px rows · 40px footer.
- The chips are filled PILLS — `--ts-state-hover` ground at rest, inverted to
  `--ts-menu-selected-bg` / `--ts-menu-selected-ink` when selected. They do
  NOT carry `.tvc-control`: that class forces `background-color: transparent`
  and paints state on a `::before`, which erased the pill and put dark ink on
  dark grey.
- The ticker column is FIXED at 211px, so the description starts at x=563 in
  every state and no ticker is ever truncated to fit its own text.
- The box's text is 16px and it draws NO focus ring — the 1px
  `--ts-control-border` frame is the frame at rest and while focused, as the
  reference's is, and the caret and selection say where focus is. The
  exception lives in `app/globals.css`, scoped to
  `[role="dialog"][data-symbol-search] input:focus-visible`.
- Enter belongs to the box and the rows only. A focused chip, filter trigger,
  Clear button or sources indicator keeps its native Enter-to-activate; the
  arrows open a closed filter menu rather than moving the row cursor behind
  it. Escape order is popover → menu → dialog, and the dialog's own key
  handler captures and stops what it consumes, so no other window listener can
  act on a key aimed at an open modal.
- The middle column is the instrument's NAME (`Bitcoin / Tether`), from a
  frontend table of the bases and quotes the running catalogue returns; an
  unknown asset falls back to its code. When the typed term matches the code
  rather than the name, the mark moves to the ticker.
- **Compare is the same dialog in compare mode**: title `Compare symbol`,
  same bands, same rows; a row ADDS an overlay and never moves the pane's own
  instrument. It never prints a canonical `instrument:v1:…` id — the old form
  titled itself `Compare instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot with`.
  Which comparison, over what window, and Remove are a secondary menu on the
  legend's own `vs …` chip.

**Deliberately omitted, and why** (owner decision recorded here, not in a
code comment): the Demonstration and Magic cursors (TradingView presentation
and pattern-recognition engines, not drawing tools), Ghost feed (a projection
feature), Image / Post / Idea (TradingView content uploads and social
publishing), and the Icons picker's Stickers tab (proprietary art). Each is
a TradingView product feature, not a shared drawing idea; none is imitated
with an inert control. Everything else in TradingView's flyouts exists here.

---

### 7d. Watchlist and right rail (TVP8 batch E — measured 2026-09-14)

Reference: `TradingView-Parity-TVP8-20260913/measurements/tv-watchlist-20260914.md`.

- The right side is a **46px icon rail COLUMN** (Watchlist, Automations,
  Indicators, Moving averages, Correlation, Order ticket; a bottom-anchored
  Help cell above a `--ts-line-strong` hairline) beside a **300px panel**.
  Of those 46 pixels, 1 is the `border-l` hairline that separates the rail
  from the panel and **45 are painted** — the reference's seam there is a
  1px rgb(46) line, not a gutter (R1c-06: rail 1395–1439, line 1394 at
  1440; 1875–1919 / 1874 at 1920). Cells are 45 wide × 46 tall with a 38×38
  chip; the column carries 1px of top padding so its **first chip is at
  y=47**, and an active chip is `--ts-line-strong`, a step above the
  `--ts-state-active` every other selected control wears. Glyphs are 20px at
  stroke 1.5 in `text-ink` at rest. A count badge is a 14px red numeric dot,
  never an accent pill.
- **The gutter is drawn once.** The chart→panel band is the workspace row's
  own 4px `gap` (x=1090–1093 at 1440, 1570–1573 at 1920) and the panel draws
  no strip of its own: its 300 pixels are 300 of CONTENT. The grip that
  closes the panel is a **persistent** 10×24 notch in that band, the colour
  of the panel, anchored 60px above the bottom edge — never hover-only. The
  band is also a `col-resize` handle: the width is device-local under
  `tv.watchlist.width.v1`, bounded 260–420, because the reference serves one
  account 300 at 1440 and 346 at 1920.
- The watchlist panel: 46px title row (`{list name} ⌄` + three 38×38
  cells: add, compact, `⋯`), 29px column row on a `--ts-state-active`
  hairline, 34px add row with a magnifier, asset-class group bands of
  **6px of gap over a 36px row with no count**, **30px rows** — 29 of
  content and the 1px `border-b` inside it, `border-box`.
- **The row grid: the numbers get the room, the ticker truncates** (TVP8
  F-01, superseding the earlier `24px minmax(0,1fr) 72px 70px 60px` with no
  gap). Row and header share one template and one `pl-[10px] pr-2` padding —
  `18px minmax(52px,1fr) minmax(0,84px) minmax(0,64px) minmax(0,60px)` with
  an **8px `column-gap`** — so a header label sits over its own values and
  no two cells can ever share an x-range. The numeric cells are
  `text-right`, `overflow:hidden`, `white-space:nowrap`, `tabular-nums`.
  The earlier rule ("no inter-column gap", "no truncation of a value") was
  measured before the tabular ink was: `76,024.0` is 60px of 14px tabular
  numerals in a 56px track, so with nothing clipping and nothing guttering,
  three values painted over each other as one run of digits
  (`0.19280-0.004302.18%`). Which column yields is settled by the reference:
  `fable-final-5d6c91d/08_tv_watchlist.png` at 300px shows `BTCUSI`,
  `ETHUSI`, `DASHU` — **TradingView truncates the ticker and never truncates
  a number**. Where a value still will not fit its track, `lib/fitNumeric`
  drops trailing decimals rather than clipping mid-glyph.
- Asset mark, ticker 14px/400, last, change, change %. The selected row is
  transparent with a 2px inset `--ts-ring`. Row separators are
  `--ts-line-soft`. No `+` prefix on a change.
- **Quotes are printed at the instrument's tick precision**, never at the
  magnitude of the individual number, and always with
  `minimumFractionDigits === maximumFractionDigits` so a value cannot change
  width between two ticks. `Chg` takes the same decimals as `Last`, because
  it is the same instrument. The digits that changed on the last tick are
  painted in the direction colour for 600ms.
- **A row is removable from the row.** Hover or focus reveals a 24×24
  neutral **trash** over the last column (TVP8 F-05 — the reference draws a
  bin here, and `×` is this product's "dismiss" rather than "delete"),
  `Delete`/`Backspace` on a focused row does the same, and the row's `title`
  is `{name} · {VENUE} · Real-time|Delayed · {market}` — never a qualified
  storage identity, and never the venue twice — with the row's note, when it
  has one, on a second line.
- **A row carries the reader's own markings.** A flag is a 4px coloured stub
  at the row's left edge; a note is a 10px glyph after the ticker and a
  second line in the tooltip. Both are keyed by SYMBOL and device-local
  (`tv.watchlist.flags.v1`, `tv.watchlist.notes.v1`), so they follow the
  instrument onto every list it is on. A user **section** is an anchor —
  a name and the symbol it opens above (`tv.watchlist.sections.v1`, per
  list) — rendered as a band with hover rename and remove; with none, the
  asset-class grouping above is what the list draws.
- **Escape closes the innermost open thing.** The panel's window-level
  Escape closes the panel only when focus is not inside a menu, a dialog or
  a text field within it; the list menu and the add field stop the event
  themselves. `event.defaultPrevented` is not a guard — a peer handler marks
  every Escape as handled.
- **The list's NAME holds list editing** (`Make a copy…` · `Rename…` ·
  `Clear list` · `Create new list…` · the lists as `menuitemradio`s under a
  `MY WATCHLISTS` heading · `Delete list`), and **`⋯` holds view settings**
  (`Compact list` · CUSTOMIZE COLUMNS `Last` `Change` `Change %`
  `Volume (24h)` · SYMBOL DISPLAY `Mark`, `Symbol` ◉ / `Name` ○). View
  preferences are device-local under `tv.watchlist.view.v1`; the header's
  compact cell mirrors the same one. One sorted column carries one
  indicator — `Chg` sorts by the absolute move and `Chg%` by the percentage
  — and the refusal to drag while sorted is shown for a few seconds AFTER a
  refused drop, never as a standing paragraph.
- **The row's context menu is the reference's** (TVP8 F-05, superseding
  R7b-18/R8-22, which recorded flag/compare/note/section as
  GENUINELY_DIFFERENT because the product had none of them — it now has all
  four, on real state). 254px, 32px rows, 16px glyphs, anchored at the
  cursor:
  `Flag|Unflag {TICKER}` · a row of **7 flag swatches** (red, blue, green,
  orange, purple, cyan, pink — 14px circles, 8px apart, radio semantics) ·
  `Unflag all symbols` · — · `Add {TICKER} to watchlist ›` (only with more
  than one list) · `Add {TICKER} to compare` · `Add note for {TICKER}` · — ·
  `Add section` · `Add symbol…` · — · then Trading Scene's own
  `Open in the focused chart` · `Open in a new pane` · `Add alert on
  {TICKER}`. `Remove from this list` is GONE — removing is the hover trash
  and the Delete key — and **nothing in this menu is destructive-tinted**.
  Every row operates real product state; a menu row that opens nothing is
  the defect `lib/menuPayloads.ts` exists to prevent.
- The details block below the list: 24px mark + 16px/600 ticker + 32px `⋯`;
  the identity line is **`displayName()` where the catalogue holds both legs**
  (`Bitcoin / TetherUS • BINANCE`) and falls back to `{base} / {quote}`;
  `Spot • Crypto` faint; 28px/600 price; 16px change line; a market line in
  `--ts-positive-strong` only when a crypto venue's stream is live; a News
  card on `--ts-news-tint` with its label in `--ts-news-ink`; Key stats from
  the provider's 24h fields plus **`Average volume (30D)` computed from the
  last 30 CLOSED daily bars**; and **six 2×3 Performance tiles**
  (1W · 1M · 3M · 6M · YTD · 1Y), each 42px, the value 14px/600 in the
  direction colour on a 12% tint of it. A period the series cannot support
  keeps its `—`.
- Direction tokens are the reference's, **in both spellings**: a token that
  has a hex and an `-rgb` twin must declare the same colour in both, because
  `tailwind.config.ts` builds every colour from the `-rgb` one and the hex
  is read by almost nothing. Dark `--ts-positive: #22ab94` / `34 171 148`,
  `--ts-negative: #f7525f` / `247 82 95`. Light `--ts-positive: #22ab94` /
  `34 171 148` too — the reference's light watchlist cells are the same
  teal, and only `Market open` (`--ts-positive-strong`) is `#089981` in both
  themes. **The light DOWN colour is UNMEASURED**: neither light reference
  capture holds a falling row, so it stays at `#f23645` / `242 54 69` until
  one is captured rather than being guessed from the dark value.
- Light-theme neutrals here are measured, not mirrored: `--ts-line-soft`
  `#f2f2f2` (dark: `= --ts-line`), `--ts-ring` `#2e2e2e` (dark `#8c8c8c`),
  news tint `rgba(69,39,160,0.13)` (dark `rgba(179,136,255,0.20)`). Light
  column-header labels stay `--ts-ink-faint` (120); the reference's ≈173 is
  one step lighter and is recorded here rather than given a token.
- Omitted on purpose: a vendored brand-icon set (a deterministic monogram
  stands in), a draggable list/details split (a static 4px band), a news
  provider (REAL_EXTERNAL_BLOCKER — none is connected), and the reference's
  `Advanced view` table and its Alerts / Data window / Chat / streams /
  ideas / calendar / RSS / notifications / apps rail cells, which are
  destinations this product does not have.

### 7e. The chrome converges on live TradingView (owner decision 2026-09-14)

The owner resolved the open question of whether shared workstation chrome
should keep Trading Scene's older neutral palette: **it follows the current
live TradingView visual system**, measured live, with only Trading Scene's
own branding excepted. The dark ground is `#2e2e2e` (the reference's body),
every surface `#0f0f0f`, ink `#dbdbdb`, muted `#a8a8a8`, faint `#8c8c8c`,
hover chip `#2e2e2e`, active chip `#3d3d3d`, hairline `#2e2e2e`, strong
hairline `#4a4a4a` — the reference's `cold-gray` scale, re-measured in this
session (`measurements/tv-dark-palette-20260914.md`). Light: ground
`#ebebeb`, surfaces `#ffffff`, ink `#0f0f0f`, secondary `#707070`, hairline
`#dbdbdb` (`measurements/tv-light-theme-20260914.md`).

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
| nothing in globals.css is `position: fixed` over the workspace | `tests/uiContract.test.ts` |
| a menu that adopts `.tvc-menu` adopts `.tvc-menu-row` too (a `role="toolbar"` borrowing the surface is exempt) | `tests/uiContract.test.ts` |
| `PageHeader` has real call sites, not just an export | `tests/uiContract.test.ts` |
| the toolbar model and its CSS agree in all four ticket/panel combinations | `tests/chartToolbar.test.ts` |
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
| a comparison's gap notice is an info glyph on its own legend row, never a status over the range row | `tests/dom/compareGapNote.test.tsx` |
| the Data window lists Change, Volume and every study in every pane, read at the hovered bar | `tests/dom/dataWindowStudies.test.tsx` |
| a study settings dialog (built-in and Pine) is one fixed size on every tab; its tab panel scrolls | `tests/dom/studySettings.test.tsx`, `tests/dom/pineStudySettings.test.tsx` |
| the interval menu is Premium's full-height column from the viewport top (re-measured on Premium 2026-10-11: 196×900 at y=0) — not a dropdown under the caret | `tests/dom/intervals.test.tsx` |
| a study pane's buttons end 4px left of its price axis | `tests/dom/paneButtonsAxis.test.tsx` |
| a study pane's control is one `⋯` opening `Manage panes`; double-click / ⌘ double-click; collapse ↔ expand restores the height; each chart of a layout acts on its own panes | `tests/dom/studyLegend.test.tsx`, `tests/dom/paneCollapse.test.tsx`, `tests/premiumFindingsM2.test.ts` |
| the series legend's hover cluster is in flow after the identity and covers no value | `tests/dom/premiumFindingsM2.test.tsx`, `qa/premiumLock.mjs` |
| the crosshair time label carries weekday and date; the countdown is `mm:ss` under an hour | `tests/premiumFindingsM2.test.ts`, `tests/barCountdown.test.ts` |
| the chart-type menu is a full-height column from the viewport top | `tests/dom/premiumFindingsM2.test.tsx`, `tests/chartType.test.ts` |
| the toolbar Compare ＋ always opens the dialog; a comparison equal to the chart is dropped | `tests/dom/premiumFindingsM2.test.tsx`, `tests/premiumFindingsM2.test.ts` |
| the axis `⊕` sits outside the price axis; the axis chips reveal for the whole axis | `tests/dom/axisPlusButton.test.tsx` |
| a menu row's mark is an 18px glyph in a 28px box in the row's own ink — chart, Manage layouts, Indicator templates, Manage panes; stars 18 in 24 | `tests/dom/contextMenu.test.tsx`, `tests/dom/premiumFindingsM2.test.tsx`, `qa/premiumLock.mjs` |
| a right-click on a legend row is the legend's display menu; the study's own menu is its `⋯` | `tests/dom/legendStudyActions.test.tsx` |
| an alert dialog confirms in `contrast` and names its symbol in ink | `tests/alertEditing.test.ts` |
| a text tool types inline at the click (no dialog); Escape / empty removal; one undo per placed text; its keys never reach a shortcut; the floating toolbar's widget set is per tool, with no Clone or Hide | `tests/dom/drawingTextInline.test.tsx`, `tests/drawingRail.test.ts` |
| a backtest result counts one population (entries) per row and names it; the last window is "Validation", never "frozen"; a failed run leads with the reader's sentence and keeps the engine's words behind a disclosure; a run can be reproduced from its page | `tests/dom/researchResult.test.tsx`, `tests/backtestFigures.test.ts` |
| a backtest compares and names its engine CORRECTION SET, not just "v2-corrected"; a run from an older correction set is never called "Reproducible" and says what it lacks; a run whose stored settings the server now refuses leads with that sentence, hides its figures behind a disclosure and offers no Re-run or Stress; an unfinished run is "Not finished yet" | `tests/dom/researchResult.test.tsx`, `tests/backtestFigures.test.ts`, `backend/tests/backtestReadTruth.test.ts` |

Add to this table when you add a rule worth protecting. Prefer semantic DOM
assertions; do not snapshot pixels, and do not pin a Tailwind class string as a
proxy for a behaviour — that makes a CSS snapshot wearing a behaviour's name,
and it fails for reasons unrelated to what it is called.
