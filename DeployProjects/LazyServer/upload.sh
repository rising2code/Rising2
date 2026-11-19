#!/bin/bash
# Push the VM's files to R2 with wrangler (run from this folder).
#   ./upload.sh          docker-compose.yml + server.env  -> R2 server/
#   ./upload.sh seed     also pack ../../GameSpy_UnifiedServer/{data/*.db3,config} as the first
#                        configs_sync/state.tar.gz (only if R2 has no state yet - it overwrites!)
set -euo pipefail
cd "$(dirname "$0")"
BUCKET=${BUCKET:-rising2}
put() { npx --yes wrangler r2 object put "$BUCKET/$1" --file "$2" --remote; }

[ -f server.env ] || { echo "server.env missing: cp server.env.example server.env and fill it in"; exit 1; }
put server/docker-compose.yml docker-compose.yml
put server/.env server.env

if [ "${1:-}" = "seed" ]; then
  src=../../GameSpy_UnifiedServer
  stage=$(mktemp -d)
  mkdir -p "$stage/data" "$stage/config"
  cp "$src"/data/LoginDatabase.db3 "$stage/data/" 2>/dev/null || true
  cp -r "$src"/config/. "$stage/config/"
  rm -rf "$stage/config/__pycache__" "$stage/config/missing"
  tar -czf state.tar.gz -C "$stage" data config
  put configs_sync/state.tar.gz state.tar.gz
  rm -rf "$stage" state.tar.gz
fi
echo done
