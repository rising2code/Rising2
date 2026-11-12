#!/bin/sh
# Start a virtual X display, then run r2launch.exe, which starts the server and
# presses Login and Start. When the server exits, so does the container, and
# Docker's restart policy brings it back.
set -e

GAME_DIR=${R2_GAME_DIR:-/game}
SERVER_EXE=${R2_SERVER_EXE:-bin/win32/Official_DedicatedServer_131.exe}

if [ ! -f "$GAME_DIR/$SERVER_EXE" ]; then
    echo "[entrypoint] $GAME_DIR/$SERVER_EXE not found - mount the Rising Eagle install at $GAME_DIR" >&2
    exit 1
fi

rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!

# docker stop -> ask the server to close, then stop Wine
stop() {
    echo "[entrypoint] stopping"
    wineserver -k 2>/dev/null || true
    kill "$XVFB_PID" 2>/dev/null || true
    exit 0
}
trap stop TERM INT

# Wine path of the server exe (Z: is the Linux root)
WIN_EXE="Z:$(echo "$GAME_DIR/$SERVER_EXE" | tr '/' '\\')"

wine /opt/r2launch/r2launch.exe --exe "$WIN_EXE" --auto-ok "$@" &
LAUNCH_PID=$!
wait "$LAUNCH_PID"
CODE=$?
echo "[entrypoint] launcher exited with code $CODE"
wineserver -k 2>/dev/null || true
kill "$XVFB_PID" 2>/dev/null || true
exit "$CODE"
