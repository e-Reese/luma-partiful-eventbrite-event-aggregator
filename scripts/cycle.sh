#!/usr/bin/env bash
# One collection cycle. Intended for cron:
#   0 */3 * * * $HOME/workspaces/event_scraper/scripts/cycle.sh
#
# Run with --preflight to check the environment and exit without collecting.
set -euo pipefail

cd "$(dirname "$0")/.."

preflight=0
[ "${1:-}" = "--preflight" ] && preflight=1

if [ ! -f .env ]; then
  echo "cycle: .env missing — copy .env.example and set DATABASE_URL" >&2
  exit 1
fi

set -a && source .env && set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "cycle: DATABASE_URL is empty — nothing to write to, refusing to run" >&2
  exit 1
fi

# cron does not read shell profiles. ~/.zshrc never runs, so every tool this
# pipeline needs — all of them installed by profile-based version managers —
# is absent from cron's PATH. That is invisible from an interactive shell, and
# lands in the log below rather than on a terminal. Resolve them explicitly.
#
# Prepends the first candidate directory that actually contains the binary.
# Returns non-zero if it cannot be found anywhere.
ensure_on_path() {
  local bin=$1
  shift
  command -v "$bin" >/dev/null 2>&1 && return 0
  local dir
  for dir in "$@"; do
    if [ -n "$dir" ] && [ -x "$dir/$bin" ]; then
      PATH="$dir:$PATH"
      export PATH
      return 0
    fi
  done
  return 1
}

nvm_dir="${NVM_DIR:-$HOME/.nvm}"

# Prefer the version nvm itself would select, so cron matches the shell.
if ! command -v npm >/dev/null 2>&1 && [ -s "$nvm_dir/nvm.sh" ]; then
  set +eu
  # shellcheck disable=SC1090,SC1091
  . "$nvm_dir/nvm.sh" --no-use >/dev/null 2>&1
  nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
  set -eu
fi

# nvm.sh is not always sourceable in a non-interactive shell, so fall back to
# the newest installed version, then to the usual system locations.
newest_nvm=$(ls -d "$nvm_dir"/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)

missing=""
ensure_on_path node "$newest_nvm" /opt/homebrew/bin /usr/local/bin || missing="$missing node"
ensure_on_path npm  "$newest_nvm" /opt/homebrew/bin /usr/local/bin || missing="$missing npm"
# The Eventbrite collector drives a real browser via BROWSE_BIN, which is a Bun
# executable that re-spawns itself with `bun`. Without bun on PATH that source
# fails every cycle and takes roughly 90% of the dataset with it, while luma
# and partiful keep succeeding — so the cycle looks partly healthy.
ensure_on_path bun  "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin || missing="$missing bun"

if ! command -v npm >/dev/null 2>&1; then
  echo "cycle: no npm on PATH, and none found under $nvm_dir," \
       "/opt/homebrew/bin or /usr/local/bin — cron cannot run the pipeline" >&2
  exit 127
fi

if [ "$preflight" = 1 ]; then
  for bin in node npm bun; do
    echo "$bin: $(command -v "$bin" || echo MISSING)"
  done
  if [ -n "$missing" ]; then
    echo "cycle: preflight FAILED — not on PATH:$missing" >&2
    exit 1
  fi
  echo "cycle: preflight ok"
  exit 0
fi

# A missing bun does not stop the cycle: luma and partiful still collect, and
# the eventbrite failure is recorded in `runs` with its termination reason
# rather than being silently dropped.
if [ -n "$missing" ]; then
  echo "cycle: WARNING — not on PATH:$missing (affected sources will fail)" >&2
fi

mkdir -p "$HOME/.local/state"
log="$HOME/.local/state/event_scraper.log"

set +e
npm run cycle >> "$log" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  # Redirecting everything into the log is what hid 107 consecutive failures.
  # Put the failure on stderr too, so cron's own mail carries it.
  echo "cycle: FAILED (exit $status) — last lines of $log:" >&2
  tail -5 "$log" >&2
  exit "$status"
fi
