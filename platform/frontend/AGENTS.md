<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI / UX — read before changing anything visual

`docs/TRADING_SCENE_UI_UX_CONTRACT.md` is the authority on how this product
looks and behaves: tokens, density, the control-state grammar, the symbol
display policy, and which rules have tests.

It documents CURRENT INTENT. Where it and an older screenshot, branch, comment
or test disagree, the contract and the current production state win. Do not
revert a decision in it because older code did it differently — in particular:

- the symbol control shows a TICKER, never a canonical `instrument:v1:…` id;
- selection is a neutral chip, never accent blue;
- the toolbar row is 38px, dropdown rows 40px, context-menu rows 32px;
- provider/fixture error strings are never primary page copy;
- unique pages (Research, Shariah, Screener, Optimizer) use the same shared
  primitives in `components/ui.tsx` as the chart workstation.
