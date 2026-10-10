param([switch]$Once)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSCommandPath
$gitPath = 'C:\Program Files\Git\cmd\git.exe'
$branch = 'main'
$pollSeconds = 15
$logPath = Join-Path $projectPath 'github-auto-sync.log'

if (!(Test-Path -LiteralPath $gitPath)) {
  throw 'Git is not installed. Install Git for Windows, then run this script again.'
}

function Test-GitOperationInProgress {
  $gitDirectory = & $gitPath -C $projectPath rev-parse --git-dir
  return (Test-Path -LiteralPath (Join-Path $projectPath "$gitDirectory\rebase-merge")) -or
    (Test-Path -LiteralPath (Join-Path $projectPath "$gitDirectory\rebase-apply")) -or
    (Test-Path -LiteralPath (Join-Path $projectPath "$gitDirectory\MERGE_HEAD"))
}

function Sync-GitHub {
  if (Test-GitOperationInProgress) { return }

  $changes = & $gitPath -C $projectPath status --porcelain
  if (!$changes) { return }

  Start-Sleep -Seconds 3
  & $gitPath -C $projectPath add --all
  $stagedChanges = & $gitPath -C $projectPath diff --cached --quiet
  if ($LASTEXITCODE -eq 0) { return }

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  & $gitPath -C $projectPath commit -m "Automatic update $timestamp"
  if ($LASTEXITCODE -ne 0) { return }

  & $gitPath -C $projectPath pull --rebase origin $branch
  if ($LASTEXITCODE -ne 0) { return }

  & $gitPath -C $projectPath push origin $branch
}

if ($Once) {
  Sync-GitHub
  exit
}

while ($true) {
  try { Sync-GitHub } catch {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $($_.Exception.Message)" | Add-Content -LiteralPath $logPath
  }
  Start-Sleep -Seconds $pollSeconds
}
