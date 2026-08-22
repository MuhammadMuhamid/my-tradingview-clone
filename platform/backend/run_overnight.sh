#!/bin/zsh
# Overnight queue, detached — survives quitting Claude Code or closing the shell.
#
#   1. wait for the running 3-year MTF Lean test to finish
#   2. Lean walk-forward with position size FIXED at 20%   (the A/B that matters most)
#   3. MA+R:R 1h walk-forward with SIX-MONTH out-of-sample blocks
#
#   nohup ./run_overnight.sh > overnight.log 2>&1 &
#   kill $(cat .overnight.pid)          # cancel the queue
# Each job is individually resumable: completed coin-folds are skipped on restart.
set -u
HERE="${0:A:h}"
cd "$HERE" || exit 1
echo "$$" > "$HERE/.overnight.pid"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "[$(stamp)] queue started"

while pgrep -f "lean3y15m/run.ts" >/dev/null 2>&1; do sleep 120; done
echo "[$(stamp)] 3-year lean test done"

echo "[$(stamp)] ── TEST 1: lean walk-forward, size fixed at 20% ──"
npx tsx lean_wf_fixedsize/wf.ts --workers 6 >> lean_wf_fixedsize/wffixed.log 2>&1
echo "[$(stamp)] test 1 finished (exit $?)"

echo "[$(stamp)] ── TEST 2: MA+R:R 1h, six-month OOS blocks ──"
npx tsx wf6m_1h/wf.ts --workers 6 >> wf6m_1h/wf6m.log 2>&1
echo "[$(stamp)] test 2 finished (exit $?)"

echo "[$(stamp)] queue complete"
