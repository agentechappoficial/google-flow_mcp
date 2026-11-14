#!/usr/bin/env bash
set -euo pipefail

# Hardened launcher: dedicated browser profile, loopback-only CDP, no eval or process killing.
log() { printf '[flow-browser] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="$PROJECT_DIR/config/flow.config.json"
command -v node >/dev/null || die "Node.js is required"

CHROME=""
for candidate in /opt/google/chrome/chrome /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
  if [[ -x "$candidate" ]]; then CHROME="$candidate"; break; fi
done

PROFILE="Default"
CDP_PORT="9222"
USER_DATA_DIR="${FLOW_CHROME_USER_DATA_DIR:-$HOME/.local/share/google-flow-mcp/chrome-profile}"

if [[ -f "$CONFIG_PATH" ]]; then
  # NUL-separated fields avoid shell evaluation and preserve whitespace.
  mapfile -d '' -t fields < <(node - "$CONFIG_PATH" <<'NODE'
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const v of [cfg.chromeExecutable || cfg.chromePath || '', cfg.chromeProfile || 'Default', String(cfg.cdpPort ?? 9222)]) {
  process.stdout.write(String(v) + '\0');
}
NODE
  )
  CHROME="${fields[0]:-$CHROME}"
  PROFILE="${fields[1]:-Default}"
  CDP_PORT="${fields[2]:-9222}"
fi

[[ -x "$CHROME" ]] || die "Chrome executable missing"
[[ "$CDP_PORT" =~ ^[0-9]+$ ]] && ((10#$CDP_PORT >= 1024 && 10#$CDP_PORT <= 65535)) || die "Invalid CDP port"
PROFILE_PATTERN="^[a-zA-Z0-9._ -]+$"
[[ "$PROFILE" =~ $PROFILE_PATTERN ]] || die "Invalid Chrome profile name"
[[ "$USER_DATA_DIR" == /* ]] || die "Browser data directory must be absolute"
[[ "$USER_DATA_DIR" != "$HOME/.config/google-chrome" ]] || die "Refusing to use personal Chrome profile"

umask 077
mkdir -p -- "$USER_DATA_DIR"
chmod 700 -- "$USER_DATA_DIR"
if (echo >"/dev/tcp/127.0.0.1/$CDP_PORT") >/dev/null 2>&1; then
  die "CDP port is already occupied; refusing to attach or terminate another process"
fi

log "Starting isolated Chrome (CDP bound to loopback)"
"$CHROME" \
  --user-data-dir="$USER_DATA_DIR" \
  --profile-directory="$PROFILE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --disable-sync &
CHROME_PID=$!

for ((i=0; i<15; i++)); do
  if curl --silent --fail --max-time 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
    log "Chrome CDP ready"
    exit 0
  fi
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then die "Chrome exited"; fi
  sleep 1
done
die "Chrome CDP failed to start"
