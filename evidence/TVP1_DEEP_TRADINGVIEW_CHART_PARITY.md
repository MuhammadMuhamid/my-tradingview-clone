# TVP1 deep TradingView chart parity evidence

- Live access: dedicated `playwright_tv` browser, current TradingView chart URL, authenticated account menu showed `daim_claude`.
- Premium: entitlement was not exposed by the inspected account surface; Premium-only behavior is `TRADINGVIEW_PREMIUM_UNVERIFIED`.
- Workflows inspected: top toolbar and overflow, drawing rail, chart canvas/axes, right rail, bottom workstation, indicators modal/search, indicator add, layout setup, account menu, dark theme, and responsive geometry.
- Implementation: added an isolated local synthetic chart fixture adapter at `frontend/qa/chart-fixture.ts`, using the existing frontend fixture contract and explicit execution-disabled behavior.
- Repairs verified: shared 38px toolbar/rail geometry, neutral chart workstation tokens, accessible modal focus/Escape behavior, indicator search and Enter-to-add, indicator templates, layout persistence, responsive overflow/drawers.
- Preserved: Trading Scene native study catalog, Pine scripts/editor, strategy/research/optimizer/backtester tabs, correlation and automation panels, paper/demo/testnet ticket, and canonical multi-pane sync.
- Validation: focused DOM/unit tests, `git diff --check`, frontend lint/typecheck/build run before final commit.
- Remaining: dynamic data/entitlement behavior cannot be claimed from synthetic fixture or inaccessible Premium state.

Final HEAD: the clean commit containing this evidence file; verify with `git rev-parse HEAD` (reported in the completion handoff).

The live second audit found two honest partial overlaps: toolbar placement/overflow and the indicator library modal/catalog. They remain in the ledger rather than being described as exact parity.
