#!/bin/bash
# Rising2 "LazyServer": OVH userData. The worker fills the __PLACEHOLDERS__ and passes this
# file as userData when it creates the VM; cloud-init runs it once as root on first boot.
#
#   cloud_init.sh          first boot: docker, game files, state from R2, DNS, compose up
#   cloud_init.sh tick     every minute (systemd timer): stop flag; every 15 min: sync + idle check
#   cloud_init.sh sync     upload SQLite + config to R2 now
#   cloud_init.sh teardown final sync, then ask the worker to delete this VM
set -uo pipefail

WORKER_URL="__WORKER_URL__"
TOKEN="__TOKEN__"
GAME_ZIP_URL="__GAME_ZIP_URL__"   # "none" = skip the game files (test server)
SSH_PUBKEY="__SSH_PUBKEY__"       # optional: one public key let in for the default user (debugging)

APP=/opt/rising2                 # compose project: docker-compose.yml, .env, gamespy/{data,config}
GAME=/srv/rising2/game           # unzipped Game.zip (the folder with bin/ and data/)
SELF=$APP/r2.sh
IDLE_CHECKS=${IDLE_CHECKS:-2}    # this many 15-min checks in a row with 0 players -> teardown
STOP_HOUR=05                     # Israel time: teardown anyway

log() { echo "[r2] $*"; logger -t rising2 "$*" 2>/dev/null || true; }

api() { # api METHOD PATH [curl args...]
  local m=$1 p=$2; shift 2
  curl -4 -fsS --retry 3 --retry-delay 5 -X "$m" -H "Authorization: Bearer $TOKEN" "$@" "$WORKER_URL$p"
}

# Status line for the landing page / Discord (/status). Optional 2nd arg sets the state.
say() {
  log "$1"
  local msg=${1//\\/\\\\}; msg=${msg//\"/\\\"}
  local st=""; [ -n "${2:-}" ] && st=",\"state\":\"$2\""
  api POST /event -H "content-type: application/json" -d "{\"msg\":\"$msg\"$st}" >/dev/null || true
}

fail() { say "Init failed: $1" error; exit 1; }

# ---------------------------------------------------------------- state sync (R2 configs_sync/)

sync_up() {
  [ -d "$APP/gamespy" ] || return 0
  local stage; stage=$(mktemp -d)
  mkdir -p "$stage/data" "$stage/config"
  # Live-safe copy of each SQLite file (WAL included) through the backup API
  python3 - "$APP/gamespy/data" "$stage/data" <<'PY'
import glob, os, sqlite3, sys
src, dst = sys.argv[1:3]
for f in glob.glob(os.path.join(src, "*.db")) + glob.glob(os.path.join(src, "*.db3")):
    a = sqlite3.connect(f); b = sqlite3.connect(os.path.join(dst, os.path.basename(f)))
    a.backup(b); b.close(); a.close()
PY
  cp -r "$APP/gamespy/config/." "$stage/config/" 2>/dev/null || true
  rm -rf "$stage/config/__pycache__"
  tar -czf "$stage.tgz" -C "$stage" data config
  if api PUT /r2/configs_sync/state.tar.gz --data-binary "@$stage.tgz" >/dev/null; then
    log "synced state to R2 ($(du -h "$stage.tgz" | cut -f1))"
  else
    say "WARNING: state sync to R2 failed"
  fi
  rm -rf "$stage" "$stage.tgz"
}

sync_down() {
  mkdir -p "$APP/gamespy/data" "$APP/gamespy/config"
  # Only a real 404 means "first run". Any other failure must stop here: starting empty
  # would overwrite the saved stats at the next sync.
  local code
  code=$(curl -4 -sS --retry 5 --retry-delay 5 --retry-all-errors -o /tmp/state.tgz -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" "$WORKER_URL/r2/configs_sync/state.tar.gz")
  case "$code" in
    200) tar -xzf /tmp/state.tgz -C "$APP/gamespy" || fail "unpack saved state"
         rm -f /tmp/state.tgz; say "Restored accounts and stats from R2" ;;
    404) say "No saved state in R2 - starting with empty databases" ;;
    *)   fail "download saved state (HTTP $code)" ;;
  esac
}

# ---------------------------------------------------------------- first boot

# The VM is made with no SSH key; if the worker passed one (SSH_PUBLIC_KEY), let it in for the
# image's default user (debian on OVH's Debian images; else the first normal user).
# The key gets in as root and as the image's default user (debian). Root logs in with a key only
# (prohibit-password); cloud images block root over SSH, so a drop-in turns that back on.
add_ssh_key() {
  case "$SSH_PUBKEY" in ssh-*|ecdsa-*) ;; *) return 0 ;; esac
  local user home users=root
  user=$(getent passwd debian >/dev/null && echo debian || getent passwd 1000 | cut -d: -f1)
  [ -n "$user" ] && users="root $user"
  for user in $users; do
    home=$(getent passwd "$user" | cut -d: -f6)
    install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
    grep -qxF "$SSH_PUBKEY" "$home/.ssh/authorized_keys" 2>/dev/null || echo "$SSH_PUBKEY" >>"$home/.ssh/authorized_keys"
    chown "$user:$user" "$home/.ssh/authorized_keys" && chmod 600 "$home/.ssh/authorized_keys"
  done
  if [ -d /etc/ssh/sshd_config.d ]; then
    echo "PermitRootLogin prohibit-password" >/etc/ssh/sshd_config.d/00-rising2.conf
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  fi
  log "SSH key added for: $users"
}

init() {
  [ -f "$APP/.done" ] && { log "already initialised"; return; }
  mkdir -p "$APP" "$GAME"
  cp "$0" "$SELF" && chmod 700 "$SELF"
  add_ssh_key   # first, so a later failure can still be looked at over SSH
  # A "Debian 12 - Docker" image has Docker already (saves 1-2 min). Install only if docker or its
  # compose plugin is missing - an image with an old Docker and no "docker compose" gets it too.
  if docker compose version >/dev/null 2>&1; then
    say "VM booted, Docker already installed ($(docker --version | cut -d, -f1))" starting
  else
    say "VM booted, installing Docker..." starting
    curl -fsSL https://get.docker.com | sh >/var/log/r2-docker.log 2>&1 || fail "Docker install"
  fi

  api GET /r2/server/docker-compose.yml -o "$APP/docker-compose.yml" || fail "download docker-compose.yml"
  api GET /r2/server/.env -o "$APP/.env" || fail "download .env"
  chmod 600 "$APP/.env"

  say "Pulling images and downloading the game..."
  ( cd "$APP" && docker compose pull -q ) >/var/log/r2-pull.log 2>&1 &
  local pull=$!
  if [ "$GAME_ZIP_URL" = "none" ]; then
    say "GAME_ZIP_URL is none: no game files (test server)"
  elif [ ! -f "$GAME/.unzipped" ]; then
    curl -fsS --retry 3 -o /srv/rising2/Game.zip "$GAME_ZIP_URL" || fail "download Game.zip"
    python3 -m zipfile -e /srv/rising2/Game.zip "$GAME" || fail "unzip Game.zip"
    rm -f /srv/rising2/Game.zip && touch "$GAME/.unzipped"
  fi
  wait "$pull" || fail "docker compose pull"

  sync_down

  local ip
  ip=$(api POST /dns | python3 -c 'import json,sys; print(json.load(sys.stdin)["ip"])') || fail "DNS update"
  sed -i '/^PUBLIC_IP=/d' "$APP/.env" && echo "PUBLIC_IP=$ip" >>"$APP/.env"
  say "DNS points at $ip"

  ( cd "$APP" && docker compose up -d ) >/var/log/r2-up.log 2>&1 || fail "docker compose up"

  cat >/etc/systemd/system/rising2-tick.service <<EOF
[Unit]
Description=Rising2 tick (stop flag, R2 sync, idle shutdown)
[Service]
Type=oneshot
ExecStart=$SELF tick
EOF
  cat >/etc/systemd/system/rising2-tick.timer <<EOF
[Unit]
Description=Rising2 tick every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload && systemctl enable --now rising2-tick.timer

  touch "$APP/.done"
  say "Server is up! Connect to $ip (game servers need ~1 min to log in)" up
}

# ---------------------------------------------------------------- every minute

players_online() { # sum of players over every listed game server; prints -1 if unknown
  curl -fsS -m 5 http://127.0.0.1/rising2/status 2>/dev/null | python3 -c '
import json, sys
try:
    s = json.load(sys.stdin)["servers"]
    print(sum(max(len(x.get("players") or []), int((x.get("keys") or {}).get("numplayers") or 0)) for x in s))
except Exception:
    print(-1)'
}

# The player count for the landing page / Discord /status (GET /api/status "players"). Sent only
# when it changed, so a quiet server costs no requests; -1 (unknown) is sent as null.
report_players() {
  local n last
  n=$(players_online)
  last=$(cat "$APP/players_reported" 2>/dev/null || echo none)
  [ "$n" = "$last" ] && return 0
  local v=$n; [ "$n" -ge 0 ] 2>/dev/null || v=null
  api POST /players -H "content-type: application/json" -d "{\"players\":$v}" >/dev/null && echo "$n" >"$APP/players_reported"
}

tick() {
  exec 9>/run/rising2.lock; flock -n 9 || exit 0

  if api GET /should-stop 2>/dev/null | grep -q '"stop":true'; then teardown_now "Stop requested"; fi
  report_players

  [ $((10#$(date +%M) % 15)) -eq 0 ] || exit 0
  sync_up

  if [ "$(TZ=Asia/Jerusalem date +%H)" = "$STOP_HOUR" ]; then teardown_now "Daily ${STOP_HOUR}:00 shutdown"; fi

  local n idle
  n=$(players_online)
  idle=$(cat "$APP/idle" 2>/dev/null || echo 0)
  if [ "$n" = "0" ]; then idle=$((idle + 1)); else idle=0; fi
  echo "$idle" >"$APP/idle"
  log "players=$n idle_checks=$idle/$IDLE_CHECKS"
  if [ "$idle" -ge "$IDLE_CHECKS" ]; then teardown_now "No players for $((IDLE_CHECKS * 15)) min"; fi
}

teardown_now() {
  say "$1: saving state and shutting down..." stopping
  ( cd "$APP" && docker compose stop -t 30 ) >/dev/null 2>&1 || true
  sync_up
  # The VM can't delete itself: the worker deletes it (and resets DNS).
  api POST /teardown >/dev/null || say "WARNING: teardown call failed, VM still running"
  exit 0
}

case "${1:-init}" in
  init) init 2>&1 | tee -a /var/log/rising2-init.log ;;
  tick) tick ;;
  sync) sync_up ;;
  teardown) teardown_now "Manual teardown" ;;
  *) echo "usage: $0 [init|tick|sync|teardown]"; exit 2 ;;
esac
