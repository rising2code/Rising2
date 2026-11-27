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
# the commit being deployed (shown on the site by step 07); "+dirty" if DeployProjects has uncommitted changes
if commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null); then
  [ -n "$(git -C "$root" status --porcelain -- . 2>/dev/null)" ] && commit="$commit+dirty"
  args+=(-e "GIT_COMMIT=$commit")
fi
if [ "$step" != list ] && [ "$step" != token ]; then
  # exact name, name without its number, or else a prefix that matches only one step ("06", "05a")
  all=$(cd "$here/steps" && for d in */; do [ -f "$d/step.mjs" ] && echo "${d%/}"; done)
  dir=$(grep -xF "$step" <<<"$all" || grep -E "^[0-9]+[a-z]?-" <<<"$all" | awk -v s="$step" '{ n=$0; sub(/^[0-9]+[a-z]?-/, "", n); if (n == s) print $0 }' | head -1 || true)
  if [ -z "$dir" ]; then
    hits=$(awk -v s="$step" '{ n=$0; sub(/^[0-9]+[a-z]?-/, "", n); if (index($0, s) == 1 || index(n, s) == 1) print $0 }' <<<"$all")
    if [ "$(grep -c . <<<"$hits")" -gt 1 ]; then echo "'$step' matches more than one step: $(echo $hits | tr ' ' ',')"; exit 1; fi
    dir=$hits
  fi
  [ -n "$dir" ] || { echo "no step '$step' - run: $0 list"; exit 1; }
  env="$here/steps/$dir/step.env"
  [ -f "$env" ] || { echo "Missing $env - cp $here/steps/$dir/step.env.example $env and fill it in"; exit 1; }
  args+=(--env-file "$env"); step=$dir
fi
exec docker "${args[@]}" "$image" "$step" "$action"
