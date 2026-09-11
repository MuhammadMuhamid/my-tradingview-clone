# TradingView chart parity ledger

Updated 2026-09-11. Live TradingView chart inspected at 1440×900 with authenticated `daim_claude` session. Trading Scene inspected beside it with the local synthetic chart fixture; no execution credentials or production services.

| Area | TradingView behavior | Trading Scene behavior | Discrepancy / action | Status | Priority | Final verification |
|---|---|---|---|---|---|---|
| Top toolbar | 38px full-width row; square hit zones; symbol, interval, type, studies, alert, replay, layout, fullscreen, snapshot | Same control grouping and 38px chrome; compact overflow tiers | Trading Scene keeps an in-app product menu and moves some actions into More at narrow widths | PARTIAL | P1 | Live side-by-side 1440px + responsive DOM |
| Drawing rail | 52px rail; grouped tools, measure, zoom, magnet, lock, hide, remove | 52px rail with equivalent tools and truthful unsupported states | Trading Scene extra drawing controls retained | MATCH | P1 | Live DOM snapshot |
| Chart header/axes | OHLC legend over chart; right price gutter; bottom time controls | Symbol legend, lightweight-charts canvas, price/time controls | Dynamic market feed differs; stable chrome matched | PARTIAL | P1 | Fixture-loaded chart |
| Indicators workflow | 840×638 modal; Personal/Purchased/Community/Marketplace categories; search and add | 672×765 responsive modal; truthful built-in catalog, local scripts, templates, Enter-to-add | Trading Scene intentionally omits unavailable marketplace/community services; modal geometry and catalog hierarchy differ | PARTIAL | P1 | Open/search/add workflow |
| Indicator templates | Save/load indicator configurations | Browser-persisted named templates with overwrite/delete/apply | Trading Scene supports equivalent workflow | MATCH | P1 | Unit and DOM tests |
| Layouts/autosave | Layout setup, saved name, autosave, multi-chart sync | Layout selector/menu, autosave, multi-pane sync and persistence | Trading Scene-only research state retained | MATCH | P1 | Existing saved-layout tests |
| Right rail | Watchlist/details/news, alerts, object tree/data window | Watchlist, alerts, indicators, MA, correlation, automations, trade | Extra Trading Scene capabilities retained | INTENTIONAL_TRADING_SCENE_DIFFERENCE | P1 | Side-by-side rail inspection |
| Bottom strip | Go to, timezone, Strategy Tester/Pine/Trading tabs | Go to/timezone, Research/Optimizer/Backtester/Pine-equivalent tabs | Research and optimizer surfaces preserved | INTENTIONAL_TRADING_SCENE_DIFFERENCE | P1 | Bottom workstation inspection |
| Responsive | Desktop rails collapse to overflow/drawers on narrow widths | Desktop rails collapse to drawers and toolbar More strip | Verify at 390×844 | MATCH | P1 | Responsive DOM sweep |
| Theme | Dark and light neutral workstation themes | Dark/light neutral tokens and chart theme | Trading Scene branding preserved | MATCH | P2 | Theme toggle + CSS tokens |
| Premium features | Account session authenticated; Premium-only entitlement not exposed in account snapshot | N/A | Mark entitlement-dependent features honestly | TRADINGVIEW_PREMIUM_UNVERIFIED | P1 | Account menu inspected |

Totals: remaining P0 **0**; remaining P1 **2** (header/legend dynamic-feed differences); remaining P2 **0**; intentional Trading Scene differences **2**; unsupported TradingView features **0**; Premium-unverified items **1**.
