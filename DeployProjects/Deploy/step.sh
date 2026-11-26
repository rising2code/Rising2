#!/bin/bash
# Run one deploy step in the Docker image (built on first use). Same as step.ps1:
#   ./Deploy/step.sh list | token | <step> [deploy|undeploy|check]      (REBUILD=1 to rebuild the image)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
image=rising2-deploy
step=${1:?usage: step.sh <step|list|token> [deploy|undeploy|check]}
action=${2:-deploy}

if [ "${REBUILD:-}" = 1 ] || ! docker image inspect "$image" >/dev/null 2>&1; then docker build -t "$image" "$here"; fi

args=(run --rm -v "$root:/app:ro" -v "$here/out:/out")
if [ "$step" != list ] && [ "$step" != token ]; then
  dir=$(cd "$here/steps" && ls -d */ | tr -d / | grep -E "^($step|[0-9]+[a-z]?-$step)$" | head -1 || true)
  [ -n "$dir" ] || { echo "no step '$step' - run: $0 list"; exit 1; }
  env="$here/steps/$dir/step.env"
  [ -f "$env" ] || { echo "Missing $env - cp $here/steps/$dir/step.env.example $env and fill it in"; exit 1; }
  args+=(--env-file "$env"); step=$dir
fi
exec docker "${args[@]}" "$image" "$step" "$action"
