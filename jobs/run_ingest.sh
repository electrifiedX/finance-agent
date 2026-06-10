#!/bin/bash
# jobs/run_ingest.sh — the scheduled task: ingest new bank-alert emails, then categorize.
# Called by launchd every 15 minutes. Loads .env, uses the venv Python, logs to logs/ingest.log.
#
# Make executable once:  chmod +x jobs/run_ingest.sh

set -euo pipefail

REPO="/Users/developerbluterra/Developer/finance-agent"
VENV_PY="$REPO/.venv/bin/python"
LOG="$REPO/logs/ingest.log"

mkdir -p "$REPO/logs"
cd "$REPO"

# Load environment (DATABASE_URL, ANTHROPIC_API_KEY) from the repo-root .env.
set -a
# shellcheck disable=SC1091
source "$REPO/.env"
set +a

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest run ====="
  "$VENV_PY" -m jobs.gmail_ingest --lookback-days 2
  "$VENV_PY" -m llm.categorize
  echo "===== done ====="
  echo
} >> "$LOG" 2>&1
