# Graph Report - .  (2026-08-06)

## Corpus Check
- 365 files · ~13,292,276 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1660 nodes · 3837 edges · 118 communities (91 shown, 27 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 124 edges (avg confidence: 0.79)
- Token cost: 300,212 input · 0 output

## Community Hubs (Navigation)
- TradingView UI Automation
- Optimizer Config Apply
- Live Signal Evaluation
- Autotuner Search Drivers
- Coin Universe Management
- MA+R:R Signal Indicators
- Pine Interpreter Core
- Chart Drawing Tools
- Optimizer & Backtest UI
- Frontend Dependencies
- Backtest Records & TV Diff
- Python Feature Bank
- Historical Data Backfill
- Broker Fill Model
- Backtest Detail & Chart
- Deployment Apply Scripts
- Pine Lexer & Parser
- Optimizer Eval Workers
- Alert Dispatch
- Frontend TypeScript Config
- Chart Workspace Page
- MORPHO Optimization Script
- Symbol & Candle Repositories
- Deployment Config Apply
- One-Year 15m GA Optimizer
- One-Year 1h GA Optimizer
- SRTrend 1h GA Optimizer
- Optuna Optimization
- Frontend API & Modals
- Pine Interpreter Execution
- Pine Series & Scoping
- Chart Layout Persistence
- Python Binance Data
- Pine Builtin Dispatch
- Local Backtester Docs
- Optimizer Result Viewers
- Binance WebSocket Feed
- Deployment & Strategy Types
- Backend TypeScript Config
- Optuna V8 Optimization
- Pine Strategy Mechanics
- Base Optimization Script
- Frontend Layout Store
- Optimizer Results API
- Pine Lexer Tokens
- SRTrend Eval Worker
- Live Deployment Runner
- Pine Editor UI
- Server Bootstrap & Config
- Strategy Config API
- Live Alerts UI
- Graphify Export Targets
- Graphify Query Interface
- Platform Handoff Rules
- Initial Database Schema
- Autotuner Leaderboard
- Pine Parameter Mapping
- Live Alert Architecture Docs
- Pine Input Parameter Docs
- Pine Script Repository
- Graphify Extraction Spec
- Strategy Preset Docs
- Optimization Result Docs
- OHLC Download Script
- Alert Records
- SR Pivot Engine Docs
- Graphify Pipeline Internals
- Graphify Project Integration
- Retest Precompute Cache
- App Shell & Navigation
- Graphify Watch & AST
- Graphify Merge Semantics
- Graphify Quality Gates
- Remote Config Apply
- Optimization Design Principles
- Binance Spot Demo
- CCXT Data Download
- Coin Pine Input Presets
- One-Hour Config Replace
- Swift OCR Utility
- Exit Gating Docs
- Optimizer Dashboard Export
- Parity Spec Builder
- AWS Migration Safety
- Platform Architecture Overview
- Local Postgres Script
- SR+Trend Optimization Report
- Optimizer Service Script
- Chart Layouts Migration
- Pine Scripts Migration
- Alerts Deploy Script
- Image Build & Push
- CloudShell Deploy Script
- App Configure Script
- Remote 1h Deploy
- Caddy Healthz Deploy
- Remote Config Deploy
- Stack Deploy Script
- Deployments Seed Script
- State Export Script
- Param Fix Script
- Dashboard Sync Install
- Dashboard Sync Script
- App Update Script
- Deployment Validation Script
- Chart Wipe Script
- Next Config
- Next Type Shim
- Tailwind Theme

## God Nodes (most connected - your core abstractions)
1. `Interval` - 54 edges
2. `PineInterpreter` - 51 edges
3. `computeSignals()` - 36 edges
4. `query()` - 33 edges
5. `Parser` - 31 edges
6. `StrategyParams` - 28 edges
7. `StrategyParams` - 28 edges
8. `closePool()` - 27 edges
9. `Broker` - 25 edges
10. `Expr` - 23 edges

## Surprising Connections (you probably didn't know these)
- `5m/15m micro-trend gate` --semantically_similar_to--> `Regime blindness of tuned parameters`  [INFERRED] [semantically similar]
  SR_Trend_v5_Optimization_Report_2026-05-21.md → OPTIMIZATION_SYSTEM_BLUEPRINT.md
- `Conservative fill model` --semantically_similar_to--> `Bracket and trailing stop engine`  [INFERRED] [semantically similar]
  OPTIMIZATION_SYSTEM_BLUEPRINT.md → SR_Trend_v5_Claude_Briefing_Manual.md
- `Per-coin default profiles` --semantically_similar_to--> `TIAUSDT 5m optimization result`  [INFERRED] [semantically similar]
  SR_Trend_v5_Optimization_Report_2026-05-21.md → backtest-spot/results/TIAUSDT_OPTIMIZATION.md
- `Query-first rule for codebase questions` --semantically_similar_to--> `Fast path: answer from existing graph`  [INFERRED] [semantically similar]
  CLAUDE.md → .claude/skills/graphify/SKILL.md
- `Grid/random/GA optimization drivers` --semantically_similar_to--> `Semantic extraction cache`  [INFERRED] [semantically similar]
  OPTIMIZATION_SYSTEM_BLUEPRINT.md → .claude/skills/graphify/SKILL.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graphify extraction pipeline** — _claude_skills_graphify_skill_detect, _claude_skills_graphify_skill_ast_extraction, _claude_skills_graphify_skill_semantic_extraction, _claude_skills_graphify_skill_chunk_dispatch, _claude_skills_graphify_skill_extraction_cache, _claude_skills_graphify_skill_merge_ast_semantic [EXTRACTED 1.00]
- **SR+Trend v5 long entry flow** — sr_trend_v5_claude_briefing_manual_mtf_pivot_sr, sr_trend_v5_claude_briefing_manual_retest_latch, sr_trend_v5_claude_briefing_manual_filtlong, sr_trend_v5_claude_briefing_manual_touchpathlong, sr_trend_v5_claude_briefing_manual_calclongtp [EXTRACTED 1.00]
- **Three-tier optimization promotion flow** — optimization_system_blueprint_tier1_backtest_spot, optimization_system_blueprint_tier2_pine_sweeper, optimization_system_blueprint_tier3_ui_automation, optimization_system_blueprint_promotion_pipeline, optimization_system_blueprint_acceptance_thresholds [EXTRACTED 1.00]
- **AWS Three-Layer Production Topology (app / isolated compute / private RDS)** — platform_deployment_aws_readme_three_layer_deployment, platform_deployment_aws_cloudformation_appinstance, platform_deployment_aws_cloudformation_computeinstance, platform_deployment_aws_cloudformation_database, platform_deployment_aws_compose_app_backend_service, platform_deployment_aws_compose_compute_ma1y15_service [EXTRACTED 1.00]
- **One-Year Optimizer Coin Universe and 2026-07-30 Removal Audit Trail** — platform_backend_optimizer1y15m_coins_one_year_15m_universe, platform_backend_optimizer1y1h_coins_one_year_1h_universe, platform_backend_sr_optimizer1h_coins_srtrend_v10_1h_universe, platform_backend_optimizer1y15m_archive_removed_20260730_coins_before_removal_pre_removal_15m_universe, platform_backend_optimizer1y1h_archive_removed_20260730_coins_before_removal_pre_removal_1h_universe, platform_backend_optimizer1y15m_coins_removal_20260730 [EXTRACTED 1.00]
- **2026-05 Report Recommendations Realised as v10 Pine Inputs** — reports_sr_trend_v5_optimization_report_2026_05_21_future_pine_inputs, reports_sr_trend_v5_optimization_report_2026_05_21_micro_trend_gate, reports_sr_trend_v5_optimization_report_2026_05_21_exit_hierarchy, platform_backend_parity_inputs_readable_mtf_ma_stack, platform_backend_parity_inputs_readable_soft_exit_gate, platform_backend_parity_inputs_readable_overextension_blocks [INFERRED 0.85]

## Communities (118 total, 27 thin omitted)

### Community 0 - "TradingView UI Automation"
Cohesion: 0.05
Nodes (54): apply_settings(), build_fieldnames(), ensure_strategy_tester_open(), login(), main(), open_settings_dialog(), Page, Path (+46 more)

### Community 1 - "Optimizer Config Apply"
Cohesion: 0.09
Nodes (20): main(), ranked(), main(), ranked(), AutoTuner, Driver, js_get_inputs(), js_inputs_info() (+12 more)

### Community 2 - "Live Signal Evaluation"
Cohesion: 0.11
Nodes (37): main(), BrokerOptions, evaluateBar(), LiveDecision, MODULES, buildMergeIndex(), feedKey(), FeedStore (+29 more)

### Community 3 - "Autotuner Search Drivers"
Cohesion: 0.09
Nodes (37): amain(), append_result(), BaseDriver, ensure_tester_open(), evaluate_config(), export_best(), GADriver, genome_to_params() (+29 more)

### Community 4 - "Coin Universe Management"
Cohesion: 0.04
Nodes (48): Post-Removal 15m Active Universe Snapshot, Pre-Removal 15m Universe Snapshot (23 pairs), One-Year 15m Optimizer Coin Universe, 2026-07-30 Coin Removal (history preserved, reversible), Post-Removal 1h Active Universe Snapshot, Pre-Removal 1h Universe Snapshot (23 pairs), One-Year 1h Optimizer Coin Universe, Confirmed-Bar-Only Signals + 3Commas Bar-Close Entries (+40 more)

### Community 5 - "MA+R:R Signal Indicators"
Cohesion: 0.09
Nodes (42): alphaTrend(), computeSignals(), FALSE_ARR(), feedOf(), hacolt(), maMtf(), NAN_ARR(), pickSrc() (+34 more)

### Community 6 - "Pine Interpreter Core"
Cohesion: 0.06
Nodes (25): BreakSignal, ContinueSignal, DEFAULT_COLORS, inferKind(), last(), LIMITS, NAMED_COLORS, PineError (+17 more)

### Community 7 - "Chart Drawing Tools"
Cohesion: 0.10
Nodes (35): distToDrawing(), Drag, DrawingCanvas(), drawOne(), far(), fmtDuration(), INTERVAL_SEC, ToPx (+27 more)

### Community 8 - "Optimizer & Backtest UI"
Cohesion: 0.11
Nodes (31): Metric, OptimizersPage(), SYSTEMS, BacktestForm(), INTERVALS, isoDaysAgo(), DeploymentForm(), INTERVALS (+23 more)

### Community 9 - "Frontend Dependencies"
Cohesion: 0.06
Nodes (35): autoprefixer, lightweight-charts, next, dependencies, lightweight-charts, next, react, react-dom (+27 more)

### Community 10 - "Backtest Records & TV Diff"
Cohesion: 0.14
Nodes (28): main(), parseCsv(), parseJson(), TvTrade, main(), backtestRoutes(), BacktestOutput, MODULES (+20 more)

### Community 11 - "Python Feature Bank"
Cohesion: 0.12
Nodes (29): Any, DataFrame, StrategyParams, Precomputes all indicator columns once per unique parameter value. Avoids recomp, Assemble all indicator columns needed by simulate() for params p., align_htf_to_5m(), atr(), ema() (+21 more)

### Community 12 - "Historical Data Backfill"
Cohesion: 0.13
Nodes (27): COINS, main(), COINS, main(), PLAN, refreshTail(), START, TAIL_ONLY (+19 more)

### Community 13 - "Broker Fill Model"
Cohesion: 0.11
Nodes (11): Broker, Bars, runBars(), RunResult, runBars(), RunOptions, OPTS, REASONS (+3 more)

### Community 14 - "Backtest Detail & Chart"
Cohesion: 0.18
Nodes (22): BacktestDetail(), BacktestsPage(), CandleChart(), ChartPriceLine, LegendBar, streamUrl(), EquityCurve(), Metrics() (+14 more)

### Community 15 - "Deployment Apply Scripts"
Cohesion: 0.12
Nodes (22): main(), coins, main(), readParams(), main(), params(), main(), rankedResult() (+14 more)

### Community 17 - "Optimizer Eval Workers"
Cohesion: 0.08
Nodes (23): chartTf, endRaw, feedCache, getFeed(), getTick(), Job, sleep(), startMs (+15 more)

### Community 18 - "Alert Dispatch"
Cohesion: 0.15
Nodes (23): buildPayload(), BuiltAlert, customDedupeKey(), deliver(), DeliveryResult, SignalContext, sleep(), validateWebhookUrl() (+15 more)

### Community 19 - "Frontend TypeScript Config"
Cohesion: 0.07
Nodes (27): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+19 more)

### Community 20 - "Chart Workspace Page"
Cohesion: 0.12
Nodes (24): HISTORY_OPTIONS, INTERVALS, Panel, stableStringify(), todayISO(), TvWorkspace(), INTERVAL_MS, AlertModal() (+16 more)

### Community 21 - "MORPHO Optimization Script"
Cohesion: 0.16
Nodes (22): find_data_files(), main(), meets_constraints(), parse_date(), Path, Random, StrategyParams, Timestamp (+14 more)

### Community 22 - "Symbol & Candle Repositories"
Cohesion: 0.15
Nodes (19): main(), PLAN, QUOTE_ORDER, symbolRoutes(), listExchangeSymbols(), CandleRow, countCandles(), getCandles() (+11 more)

### Community 23 - "Deployment Config Apply"
Cohesion: 0.16
Nodes (20): main(), main(), resolveByOrig(), query(), markDelivery(), createDeployment(), deleteDeployment(), getDeployment() (+12 more)

### Community 24 - "One-Year 15m GA Optimizer"
Cohesion: 0.13
Nodes (14): BEST, Driver, HERE, Job, loadDriver(), loadSeeds(), main(), ParamDef (+6 more)

### Community 25 - "One-Year 1h GA Optimizer"
Cohesion: 0.13
Nodes (14): BEST, Driver, HERE, Job, loadDriver(), loadSeeds(), main(), ParamDef (+6 more)

### Community 26 - "SRTrend 1h GA Optimizer"
Cohesion: 0.13
Nodes (14): BEST, Driver, HERE, Job, loadDriver(), loadSeeds(), main(), ParamDef (+6 more)

### Community 27 - "Optuna Optimization"
Cohesion: 0.18
Nodes (22): find_or_download(), _frame_key(), _get_retest(), main(), _make_instrumented_objective(), make_sampler(), objective(), objective_multi() (+14 more)

### Community 28 - "Frontend API & Modals"
Cohesion: 0.14
Nodes (17): Modal(), PineCompileError, PineMeta, PinePlotSeries, PineRunResult, PineShapeMark, ServerLayout, SymbolSearchResponse (+9 more)

### Community 29 - "Pine Interpreter Execution"
Cohesion: 0.18
Nodes (4): memberPath(), PineInterpreter, Stmt, n()

### Community 31 - "Chart Layout Persistence"
Cohesion: 0.21
Nodes (17): LayoutBody, layoutRoutes(), DbLayout, defaultSyncedProperties(), deleteLayout(), getLayout(), getLayoutByName(), LayoutProperties (+9 more)

### Community 32 - "Python Binance Data"
Cohesion: 0.23
Nodes (16): fetch_klines(), load_csv(), DataFrame, Path, Download Binance Spot klines and save to CSV., save_csv(), FeatureBank, main() (+8 more)

### Community 33 - "Pine Builtin Dispatch"
Cohesion: 0.35
Nodes (5): looseEq(), normaliseStyle(), PineValue, toStr(), Expr

### Community 34 - "Local Backtester Docs"
Cohesion: 0.16
Nodes (18): UI-automation Python dependencies, backtest-spot local backtester, fetch_data.py, Not Pine parity disclaimer, optimize_morpho.py, run_backtest.py, MA warmup window requirement, backtest-spot Python dependencies (+10 more)

### Community 35 - "Optimizer Result Viewers"
Cohesion: 0.19
Nodes (6): color_net(), print_record(), Exact cached newline count; after first run only appended bytes are read., ResultIndex, show(), total_raw_backtests()

### Community 36 - "Binance WebSocket Feed"
Cohesion: 0.20
Nodes (6): BarCloseEvent, BinanceWsManager, RawKlineMsg, streamName(), upsertCandles(), Candle

### Community 37 - "Deployment & Strategy Types"
Cohesion: 0.16
Nodes (14): ActiveDeployment, FeedNeed, FeedNeed, DbDeployment, DbConfig, DeploymentRow, DeploymentStatus, RuntimeState (+6 more)

### Community 38 - "Backend TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, esModuleInterop, lib, module, moduleResolution, noUncheckedIndexedAccess, outDir (+9 more)

### Community 39 - "Optuna V8 Optimization"
Cohesion: 0.21
Nodes (16): find_or_download(), _frame_key(), _get_retest(), main(), _make_instrumented_objective(), make_sampler(), parse_date(), print_top() (+8 more)

### Community 40 - "Pine Strategy Mechanics"
Cohesion: 0.15
Nodes (17): Conservative fill model, Bracket and trailing stop engine, calcLongTp, f_htf_close_above_resistance, f_super_trend_htf, Flat reset guard, HTF break runner, Position state machine (FLAT/LONG/SHORT) (+9 more)

### Community 41 - "Base Optimization Script"
Cohesion: 0.22
Nodes (15): find_or_download(), frame_key(), main(), parse_date(), datetime, Path, Random, StrategyParams (+7 more)

### Community 42 - "Frontend Layout Store"
Cohesion: 0.25
Nodes (13): canStore(), createLayout(), deleteLayout(), fromServer(), getAutosave(), getCurrentLayoutId(), getLayout(), listLayouts() (+5 more)

### Community 43 - "Optimizer Results API"
Cohesion: 0.26
Nodes (14): baseParams(), BestRec, fullParams(), loadConfig(), OptConfig, optimizerDir(), optimizerKey(), optimizerRoutes() (+6 more)

### Community 44 - "Pine Lexer Tokens"
Cohesion: 0.20
Nodes (11): isDigit(), isIdentPart(), isIdentStart(), KEYWORDS, OPERATORS, PineSyntaxError, tokenize(), TokenType (+3 more)

### Community 45 - "SRTrend Eval Worker"
Cohesion: 0.18
Nodes (11): chartTf, endRaw, feedCache, getFeed(), getTick(), Job, sleep(), startMs (+3 more)

### Community 47 - "Pine Editor UI"
Cohesion: 0.21
Nodes (12): ChartOverlay, PineChartPayload, PineInputDef, PineScript, BUILTIN_SERIES, highlightLine(), KEYWORDS, NAMESPACES (+4 more)

### Community 48 - "Server Bootstrap & Config"
Cohesion: 0.29
Nodes (8): healthRoutes(), buildServer(), AppConfig, config, migrate(), startBacktestWorker(), main(), encryptLegacySecrets()

### Community 49 - "Strategy Config API"
Cohesion: 0.33
Nodes (12): strategyRoutes(), createConfig(), DbStrategy, deleteConfig(), getConfig(), getStrategyById(), getStrategyByKey(), listConfigs() (+4 more)

### Community 50 - "Live Alerts UI"
Cohesion: 0.36
Nodes (9): DeploymentsPage(), AlertFeed(), AlertsPanel(), EditAlertModal(), StatusBadge(), api, fmtAgo(), Alert (+1 more)

### Community 51 - "Graphify Export Targets"
Cohesion: 0.25
Nodes (11): Graphify slash-command trigger, graphify add URL ingest, FalkorDB export, Neo4j Cypher export, Self-composed Whisper domain hint, Whisper video/audio transcription, Graph diff after update, Incremental --update flow (+3 more)

### Community 52 - "Graphify Query Interface"
Cohesion: 0.18
Nodes (11): graphify MCP stdio server, graphify explain node explanation, Inline NetworkX traversal fallback, graphify path shortest-path lookup, save-result feedback loop, Token budget cap on traversal output, BFS and DFS traversal modes, Work memory and LESSONS.md (+3 more)

### Community 53 - "Platform Handoff Rules"
Cohesion: 0.22
Nodes (11): Backtest baseline settings, Safe change and deployment workflow, Genome value-index stability rule, MA + R:R strategy (ma_rr_v9), MyTradingView clone platform, Named watchlists, Four optimizer trees, Rank provenance recording rule (+3 more)

### Community 54 - "Initial Database Schema"
Cohesion: 0.49
Nodes (9): alerts, backtest_trades, backtests, candles, deployments, executions, strategies, strategy_configs (+1 more)

### Community 55 - "Autotuner Leaderboard"
Cohesion: 0.40
Nodes (9): color_net(), detail(), leaderboard(), load(), medal(), print_record(), ranked_history(), All evaluations for a coin, deduped, ranked by score (best first). (+1 more)

### Community 56 - "Pine Parameter Mapping"
Cohesion: 0.33
Nodes (7): format_pine_report(), params_to_pine_dict(), StrategyParams, Map StrategyParams fields → Pine v5 input names for reporting., main(), parse_date(), Timestamp

### Community 57 - "Live Alert Architecture Docs"
Cohesion: 0.22
Nodes (9): Alert dispatcher, AWS production deployment, Alert dedupe keys, liveRunner bar-close evaluator, Live signal pipeline, manualCloseReentryLock, Production security rules, Single signal emitter rule (+1 more)

### Community 58 - "Pine Input Parameter Docs"
Cohesion: 0.22
Nodes (9): MTF MA Stack with Slope Requirement (TF1–TF4), TradingView Pine Input Snapshot (in_0…in_209), Backtests Snapshot Params at Queue Time, Params as JSONB Overrides, Future Pine Inputs (requireHtfMaSlope, require5mEmaStack, minUnrealizedRForSoftExit, maxRiskPctCap), HTF MA Slope + Price Separation Filter, Macro Uptrend ≠ 5m Tradable Uptrend, 5m/15m Micro-Trend Gate (EMA 21>55, 15m ST, higher-high structure) (+1 more)

### Community 59 - "Pine Script Repository"
Cohesion: 0.36
Nodes (8): DbPineScript, deleteScript(), getScript(), listScripts(), PineScriptRow, toRow(), updateScript(), upsertScript()

### Community 60 - "Graphify Extraction Spec"
Cohesion: 0.29
Nodes (8): Discrete confidence-score rubric, DEEP_MODE aggressive inference, Hyperedges, Rationale stored as node attribute, semantically_similar_to edge, Extraction subagent prompt, EXTRACTED/INFERRED/AMBIGUOUS audit trail, UI-automation fidelity drift and report_updated flag

### Community 61 - "Strategy Preset Docs"
Cohesion: 0.25
Nodes (8): Fixed (Unsearched) Timeframe & Broker Assumptions, MORPHO Constrained Best Inputs (SR+Trend v5), Over-Extension / Parabolic / Wick Entry Blocks, R:R Mode — Swing-Low SL + Ratio TP, Per-Coin Default Profiles (APT / LDO / ENA / NEAR), Stale Retest Window (retestConfirmBars / priorAboveLb), Stop/Target Asymmetry (structBuff too wide, trail arms late), A High Score Is Evidence, Not Proof (overfitting warning)

### Community 62 - "Optimization Result Docs"
Cohesion: 0.29
Nodes (8): MORPHOUSDT 5m optimization result, TIAUSDT 5m optimization result, f_adx_trend_score, f_imba_channel, f_linreg_ohlc, f_ma_mtf, f_vwma_mtf, Stacked MTF trend gate

### Community 63 - "OHLC Download Script"
Cohesion: 0.43
Nodes (7): binance, fetch_range(), main(), parse_date(), Parse YYYY-MM-DD to milliseconds UTC., Candle duration in ms for pagination steps., timeframe_ms()

### Community 64 - "Alert Records"
Cohesion: 0.36
Nodes (6): createAlert(), DbAlert, listAlerts(), toRow(), AlertRow, DeliveryStatus

### Community 65 - "SR Pivot Engine Docs"
Cohesion: 0.32
Nodes (8): contPathLong continuation entry, f_last_pivot_low / f_last_pivot_high, filtLong filter assembly, MTF pivot support/resistance engine, Pivot strength filter (strengthOkLong), Resistance-to-support flip state, Retest latch (retestEntryOk), touchPathLong entry path

### Community 66 - "Graphify Pipeline Internals"
Cohesion: 0.29
Nodes (7): Token reduction benchmark, Parallel chunk subagent dispatch, Corpus detection step, Gemini semantic extraction backend, general-purpose subagent requirement, No API key required policy, Semantic LLM extraction (Part B)

### Community 67 - "Graphify Project Integration"
Cohesion: 0.33
Nodes (7): Agent-crawlable wiki export, Native CLAUDE.md integration, --cluster-only reclustering, Community labeling, Fast path: answer from existing graph, Graphify project usage rules, Query-first rule for codebase questions

### Community 68 - "Retest Precompute Cache"
Cohesion: 0.33
Nodes (6): precompute_retests(), DataFrame, ndarray, Precompute retest boolean masks per (frame, touch_atr, prior_lb)., True when low touches support zone and price was above it for prior_lb bars., retest_support()

### Community 69 - "App Shell & Navigation"
Cohesion: 0.33
Nodes (4): metadata, viewport, LINKS, Nav()

### Community 70 - "Graphify Watch & AST"
Cohesion: 0.40
Nodes (6): Watcher debounce window, --watch folder watcher, Node ID format rule, Post-commit auto-rebuild hook, Code-only change fast path, AST structural extraction (Part A)

### Community 71 - "Graphify Merge Semantics"
Cohesion: 0.33
Nodes (6): Verbatim source_file rule, GitHub repo clone, Cross-repo graph merge, Monorepo per-subfolder extract, build_merge replace-on-re-extract, prune_sources deletion pruning

### Community 72 - "Graphify Quality Gates"
Cohesion: 0.33
Nodes (6): Constrained query expansion, Cumulative token cost tracker, Directed graph mode, Graph health check gate, Honesty rules, AST + semantic merge (Part C)

### Community 73 - "Remote Config Apply"
Cohesion: 0.33
Nodes (5): DRY, FRESH, manifest, pool, report

### Community 74 - "Optimization Design Principles"
Cohesion: 0.40
Nodes (5): graph.json shrink guard, Information flows downward only, Friction single source of truth, Overfitting and walk-forward mitigation, Three-tier optimization architecture

### Community 75 - "Binance Spot Demo"
Cohesion: 0.50
Nodes (4): fetch_klines(), main(), Params, DataFrame

### Community 76 - "CCXT Data Download"
Cohesion: 0.50
Nodes (4): fetch_ohlcv(), main(), DataFrame, Exchange

### Community 77 - "Coin Pine Input Presets"
Cohesion: 0.70
Nodes (5): APTUSDT best Pine inputs, MORPHOUSDT best Pine inputs, Capital and friction model, Recalculate-after-order-is-filled sensitivity, SR+Trend v5 strategy

### Community 78 - "One-Hour Config Replace"
Cohesion: 0.40
Nodes (4): DRY, FRESH, manifest, pool

### Community 79 - "Swift OCR Utility"
Cohesion: 0.50
Nodes (3): AppKit, Foundation, Vision

### Community 80 - "Exit Gating Docs"
Cohesion: 0.50
Nodes (4): Loss-Streak Pause and Winning-Run Profit Cap, Soft Exit Gate — Min Unrealized R, Recommended Exit Hierarchy (R-gated soft exits), Soft-Exit Stacking (competing micro exits cut winners)

### Community 81 - "Optimizer Dashboard Export"
Cohesion: 1.00
Nodes (3): export(), load(), update_counts()

### Community 83 - "AWS Migration Safety"
Cohesion: 0.67
Nodes (3): BackupBucket (versioned, Glacier-IR lifecycle), LIVE_RUNNER_ENABLED Defaults False During Migration, Safe Migration Order (single live runner invariant)

### Community 84 - "Platform Architecture Overview"
Cohesion: 0.67
Nodes (3): Five-Stage Build Plan (schema → engine → live → UI → charting), Time/Price-Anchored Drawing Tools, TradingView-Lite Platform

### Community 86 - "SR+Trend Optimization Report"
Cohesion: 0.67
Nodes (3): HTF Uptrend Stack (1m×200 / 1h×400 / 4h VWMA / 5m ST / 1m LinReg), SR+Trend v5 Optimization Report (2026-05-21), SR+Trend v5 Optimization Report — PDF Rendering (7 pages)

## Ambiguous Edges - Review These
- `Loss-Streak Pause and Winning-Run Profit Cap` → `Soft-Exit Stacking (competing micro exits cut winners)`  [AMBIGUOUS]
  platform/backend/parity/inputs_readable.txt · relation: conceptually_related_to

## Knowledge Gaps
- **298 isolated node(s):** `ParamSpec`, `Params`, `startMs`, `endRaw`, `chartTf` (+293 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Loss-Streak Pause and Winning-Run Profit Cap` and `Soft-Exit Stacking (competing micro exits cut winners)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Series` connect `Pine Series & Scoping` to `Python Feature Bank`, `Pine Interpreter Core`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **Why does `Watchlist()` connect `Chart Workspace Page` to `Pine Interpreter Execution`, `Pine Interpreter Core`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Why does `last()` connect `Pine Interpreter Core` to `Pine Builtin Dispatch`, `Live Signal Evaluation`, `Chart Workspace Page`, `Pine Series & Scoping`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **What connects `ParamSpec`, `Params`, `startMs` to the rest of the system?**
  _298 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `TradingView UI Automation` be split into smaller, more focused modules?**
  _Cohesion score 0.05064935064935065 - nodes in this community are weakly interconnected._
- **Should `Optimizer Config Apply` be split into smaller, more focused modules?**
  _Cohesion score 0.0936408106219427 - nodes in this community are weakly interconnected._