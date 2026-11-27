# Run one deploy step in the Docker image (built on first use).
#   .\Deploy\step.ps1 list
#   .\Deploy\step.ps1 03-cloudflare-dns            # deploy
#   .\Deploy\step.ps1 cloudflare-dns undeploy      # the number can be left out
#   .\Deploy\step.ps1 06                           # or any start that matches only one step
#   .\Deploy\step.ps1 cloudflare-dns check         # only validate its step.env
#   .\Deploy\step.ps1 token                        # a new SHARED_TOKEN
#   .\Deploy\step.ps1 -Rebuild list                # rebuild the image first
param([Parameter(Mandatory)][string]$Step, [string]$Action = "deploy", [switch]$Rebuild)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path $here
$image = "rising2-deploy"

docker image inspect $image *> $null
if ($Rebuild -or $LASTEXITCODE -ne 0) { docker build -t $image $here; if ($LASTEXITCODE) { exit 1 } }

$run = @("run", "--rm", "-v", "${root}:/app:ro", "-v", "${here}/out:/out")
# the commit being deployed (shown on the site by step 07); "+dirty" if DeployProjects has uncommitted changes
$commit = git -C $root rev-parse --short HEAD 2>$null
if ($commit) { if (git -C $root status --porcelain -- . 2>$null) { $commit += "+dirty" }; $run += @("-e", "GIT_COMMIT=$commit") }
if ($Step -notin @("list", "token")) {
  # exact name, name without its number, or else a prefix that matches only one step ("06", "05a", "cloudflare-p")
  $all = Get-ChildItem (Join-Path $here "steps") -Directory | Where-Object { Test-Path (Join-Path $_.FullName "step.mjs") }
  $esc = [regex]::Escape($Step)
  # ("repeated-" marks the steps run again and again; it can be left out too: "cloudflare-pages")
  $dir = @($all | Where-Object { $_.Name -eq $Step -or $_.Name -match "^\d+[a-z]?-(repeated-)?$esc$" }) | Select-Object -First 1
  if (-not $dir) {
    $hits = @($all | Where-Object { $_.Name -match "^$esc" -or $_.Name -match "^\d+[a-z]?-(repeated-)?$esc" })
    if ($hits.Count -gt 1) { Write-Host "'$Step' matches more than one step: $($hits.Name -join ', ')" -ForegroundColor Yellow; exit 1 }
    $dir = $hits | Select-Object -First 1
  }
  if (-not $dir) { Write-Host "no step '$Step' - run: .\Deploy\step.ps1 list" -ForegroundColor Yellow; exit 1 }
  $envFile = Join-Path $dir.FullName "step.env"
  if (-not (Test-Path $envFile)) {
    Write-Host "Missing $envFile - copy step.env.example next to it and fill it in:" -ForegroundColor Yellow
    Write-Host "  Copy-Item `"$($dir.FullName)\step.env.example`" `"$envFile`""
    exit 1
  }
  $run += @("--env-file", $envFile)
  $Step = $dir.Name
}
docker @run $image $Step $Action
exit $LASTEXITCODE
