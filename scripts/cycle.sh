#!/usr/bin/env bash
# One collection cycle. Intended for cron:
#   0 */3 * * * $HOME/workspaces/event_scraper/scripts/cycle.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "cycle: .env missing — copy .env.example and set DATABASE_URL" >&2
  exit 1
fi

set -a && source .env && set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "cycle: DATABASE_URL is empty — nothing to write to, refusing to run" >&2
  exit 1
fi

mkdir -p "$HOME/.local/state"
npm run cycle >> "$HOME/.local/state/event_scraper.log" 2>&1
