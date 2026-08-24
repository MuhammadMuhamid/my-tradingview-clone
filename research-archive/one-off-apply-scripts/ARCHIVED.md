# One-off apply scripts — ARCHIVED

**Status: retired. These are a record of two specific deployment changes, not
tools. They will not run.**

Both scripts hardcode a fixed list of coins, a fixed optimizer rank per coin,
and absolute `/tmp/*.json` input files that no longer exist:

| Script | What it applied | Inputs it needs |
|---|---|---|
| `apply_allo_rif_dexe.ts` | ALLOUSDT rank 1, RIFUSDT rank 2, DEXEUSDT rank 1878, all at 320.01 USDT | `/tmp/allo-rank1.json`, `/tmp/rif-rank2.json`, `/tmp/dexe-rank1878.json` |
| `apply_dexe1889_jto26_morpho462.ts` | DEXEUSDT rank 1889, JTOUSDT rank 26, MORPHOUSDT rank 462, all at 320.01 USDT | `/tmp/dexe-rank1889.json`, `/tmp/jto-rank26.json`, `/tmp/morpho-rank462.json` |

They are kept because they name exactly which rank of which tree went live at
which size — provenance that exists nowhere else.

`OPT-26`: neither had a dry-run flag, and both set `status='active'` with an
order size written into the file. The general-purpose scripts that remain in
`platform/backend/scripts/` now preview by default and require an explicit
`--apply --buy <usdt>`. To repeat one of these changes, use
`apply_rank_deployment.ts`, which takes the symbol, rank and size as arguments.
