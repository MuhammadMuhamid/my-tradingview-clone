# Browsing Trading Scene and TradingView for parity work

Two browsers, two profiles, never shared. TradingView is an authenticated,
paid account; Trading Scene is the local product. Cookies and tokens from one
must never be reachable from the other, and none are committed anywhere.

## The two Playwright MCP targets

| target | what it opens | profile | registered in |
|---|---|---|---|
| `playwright-tv` | https://www.tradingview.com (signed in) | `~/Library/Caches/ms-playwright/tradingview-premium` | Claude: `~/.claude.json` (user scope) |
| `playwright-ts` | http://127.0.0.1:3000 only | `~/Library/Caches/ms-playwright/trading-scene` | Claude: `.mcp.json` at the repo root (project scope). Codex: `~/.codex/config.toml` `[mcp_servers.playwright-ts]` |

Both are the stock `@playwright/mcp` server with different flags — no custom
server. `playwright-ts` is pinned to `--allowed-origins` on localhost, opens at
`--viewport-size 1440,900`, and writes screenshots under
`TradingView-Parity-TVP8-20260913/tradingscene/` by default.

Registration formats, for the record:

```jsonc
// Claude Code — .mcp.json (project) or ~/.claude.json (user)
{ "mcpServers": { "playwright-ts": { "type": "stdio", "command": "npx",
  "args": ["-y", "@playwright/mcp@latest", "--browser", "chrome",
    "--user-data-dir", "/Users/m/Library/Caches/ms-playwright/trading-scene",
    "--viewport-size", "1440,900",
    "--allowed-origins", "127.0.0.1:3000;localhost:3000;127.0.0.1:4000;localhost:4000",
    "--caps", "vision,devtools"] } } }
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.playwright-ts]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--browser", "chrome",
  "--user-data-dir", "/Users/m/Library/Caches/ms-playwright/trading-scene",
  "--viewport-size", "1440,900",
  "--allowed-origins", "127.0.0.1:3000;localhost:3000;127.0.0.1:4000;localhost:4000",
  "--caps", "vision,devtools"]
```

A newly registered MCP server is available from the NEXT session, not the
current one.

### One instance per profile

`@playwright/mcp` refuses to start a second browser on a profile that is in
use: *"Browser is already in use for …, use --isolated"*. Every stale server
from an earlier session holds its profile until it exits. If the target errors
with that message, find and stop the stale servers — they are automation
processes, not the user's own Chrome:

```bash
pgrep -fl "playwright-mcp --browser chrome --user-data-dir"   # list, with profile path
kill <pid>                                                      # the stale ones only
```

On 2026-09-14 eleven of them from 9–11 September were found holding the
TradingView profile.

## Scripted captures: `platform/frontend/scripts/ts-capture.mjs`

For evidence that has to be reproducible — a named state, a fixed viewport, a
theme, a geometry sidecar — the MCP session is the wrong tool: it is
interactive and its output names are timestamps. The capture script opens the
same `trading-scene` profile headlessly (it needs the `playwright-core`
devDependency and the installed Chrome), performs the interaction, and writes a
PNG plus a JSON sidecar with the served build id, the viewport, the theme and
the measured boxes and computed styles of any selectors asked for.

```bash
cd platform/frontend
node scripts/ts-capture.mjs --out shell.png                              # /chart, 1440×900, dark
node scripts/ts-capture.mjs --script scripts/ts-state-btc1h.mjs \
  --out shell-btc-1h.png --json shell-btc-1h.json \
  --measure '[data-toolbar-row="primary"] > *'                           # the matched primary state
node scripts/ts-capture.mjs --script scripts/ts-state-btc1h.mjs \
  --click 'button[aria-label="Indicators"]' --out indicators.png          # a dialog
node scripts/ts-capture.mjs --route /chart --theme light --viewport 390x844 --out phone-light.png
node scripts/ts-capture.mjs --press / --out symbol-search.png
```

`--click`, `--hover`, `--press`, `--type sel=text`, `--wait ms` repeat and
apply in order; `--script file.mjs` runs `export default async (page) => {}`
first (`scripts/ts-state-btc1h.mjs` puts the pane on BINANCE BTCUSDT 1h and
waits for the bars). `HEADED=1` shows the browser.

The sidecar's `buildId` is what the running server actually served and
`diskBuildId` is `.next/BUILD_ID` in this checkout. A capture is evidence for a
HEAD only when the served build was made from it — rebuild and restart
(`docs/OPERATIONS.md`, the owner-preview restart block) after product changes
before taking "after" captures.

## Verified capabilities of the local target (2026-09-14)

open `/chart` and every main route; click and hover controls; open dialogs and
menus; resize the viewport; read DOM geometry and computed styles; take
viewport and full-page screenshots; keyboard input. Capture of the matched
1440×900 shell takes ~5s.

## Matched-state protocol

See `TradingView-Parity-TVP8-20260913/00_OWNER_VISUAL_VETO.md`: 1440×900, dark,
BTCUSDT, 1h or 4h, candles, the same panel/dialog/menu/tab open on both. TV
captures are taken through `playwright-tv` and then copied out of the
repository's `.playwright-mcp/` (gitignored) into the campaign's
`tradingview/` folder with a descriptive name.
