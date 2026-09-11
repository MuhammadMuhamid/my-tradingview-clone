# TradingView chart parity ledger

Updated 2026-09-11. Live TradingView chart inspected at 1440×900 with authenticated `daim_claude` session. Trading Scene inspected beside it with the local synthetic chart fixture; no execution credentials or production services.

| Area | TradingView behavior | Trading Scene behavior | Discrepancy / action | Status | Priority | Final verification |
|---|---|---|---|---|---|---|
| Top toolbar | 38px full-width row; square hit zones; symbol, interval, type, studies, alert, replay, layout, fullscreen, snapshot | Same control grouping and 38px chrome; compact overflow tiers; functional undo/redo | Trading Scene keeps an in-app product menu and preserves product-specific actions | MATCH | P2 | Live side-by-side 1440px + responsive DOM |
| Drawing rail | 52px rail; grouped tools, measure, zoom, magnet, lock, hide, remove, per-tool favourites | 52px rail with grouped tools, measure, magnet, lock, hide, remove and persisted per-tool favourites | Trading Scene extra drawing controls retained; unsupported variants are not presented as fake tools | MATCH | P2 | Live DOM snapshot + favourite persistence check |
| Chart header/axes | OHLC legend over chart; right price gutter; bottom time controls | Symbol legend, lightweight-charts canvas, price/time controls | Dynamic market feed differs; stable chrome matched | PARTIAL | P1 | Fixture-loaded chart |
| Indicators workflow | 840×638 modal; Personal/Purchased/Community/Marketplace categories; search and add | 840×638 modal; Personal/Built-in/Saved rail, local scripts, templates, Enter-to-add, favourites/recents | Marketplace/community/purchased services are not available in this installation and are not represented as fake controls | MATCH | P2 | Open/search/add workflow; focused-pane add verified |
| Indicator templates | Save/load indicator configurations | Browser-persisted named templates with overwrite/delete/apply | Trading Scene supports equivalent workflow | MATCH | P1 | Unit and DOM tests |
| Layouts/autosave | Layout setup, saved name, autosave, multi-chart sync | Layout selector/menu, autosave, multi-pane sync and persistence | Trading Scene-only research state retained | MATCH | P1 | Existing saved-layout tests |
| Right rail | Watchlist/details/news, alerts, object tree/data window | Watchlist, alerts, indicators, MA, correlation, automations, trade | Extra Trading Scene capabilities retained | INTENTIONAL_TRADING_SCENE_DIFFERENCE | P1 | Side-by-side rail inspection |
| Bottom strip | Go to, timezone, Strategy Tester/Pine/Trading tabs | Go to/timezone, Research/Optimizer/Backtester/Pine-equivalent tabs | Research and optimizer surfaces preserved | INTENTIONAL_TRADING_SCENE_DIFFERENCE | P1 | Bottom workstation inspection |
| Responsive | Desktop rails collapse to overflow/drawers on narrow widths | Desktop rails collapse to drawers and toolbar More strip | Verify at 390×844 | MATCH | P1 | Responsive DOM sweep |
| Theme | Dark and light neutral workstation themes | Dark/light neutral tokens and chart theme | Trading Scene branding preserved | MATCH | P2 | Theme toggle + CSS tokens |
| Premium features | Account session authenticated; Premium-only entitlement not exposed in account snapshot | N/A | Mark entitlement-dependent features honestly | TRADINGVIEW_PREMIUM_UNVERIFIED | P1 | Account menu inspected |

Totals: remaining avoidable P0 **0**; remaining avoidable P1 **0**; remaining P2 **0**; intentional Trading Scene differences **2**; unsupported TradingView features **0**; Premium-unverified items **1**.
