## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

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
