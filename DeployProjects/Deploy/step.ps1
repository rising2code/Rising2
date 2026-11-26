# Run one deploy step in the Docker image (built on first use).
#   .\Deploy\step.ps1 list
#   .\Deploy\step.ps1 03-cloudflare-dns            # deploy
#   .\Deploy\step.ps1 cloudflare-dns undeploy      # the number can be left out
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
if ($Step -notin @("list", "token")) {
  $dir = Get-ChildItem (Join-Path $here "steps") -Directory | Where-Object { $_.Name -eq $Step -or $_.Name -match "^\d+[a-z]?-$([regex]::Escape($Step))$" } | Select-Object -First 1
  if (-not $dir) { Write-Error "no step '$Step' - run: .\Deploy\step.ps1 list" }
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
