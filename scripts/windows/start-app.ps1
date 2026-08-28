[CmdletBinding()]
param(
  [switch]$DoNotOpenBrowser,
  [ValidateRange(1024, 65535)][int]$Port = 4170
)

$ErrorActionPreference = "Stop"
$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
# Executando do repositorio: raiz do app e a pasta acima de scripts\windows.
$appRoot = if (Test-Path (Join-Path $installRoot "src\dashboard-server.mjs")) {
  $installRoot
} else {
  (Split-Path -Parent $installRoot)
}
$appRoot = Join-Path $appRoot ""
$nodePath = Join-Path $installRoot "runtime\node\node.exe"
if (-not (Test-Path $nodePath)) {
  $nodePath = "node.exe"
}
$serverPath = Join-Path $appRoot "src\dashboard-server.mjs"
$url = "http://127.0.0.1:$Port/"
$env:DASHBOARD_PORT = [string]$Port
$env:DASHBOARD_HOST = "127.0.0.1"

if (-not (Test-Path $serverPath)) {
  throw "O servidor local nao foi encontrado. Execute novamente o instalador."
}

function Test-ReelforgeOnline {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-ReelforgeOnline)) {
  $dataDirectory = Join-Path $appRoot "data"
  New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
  $stdout = Join-Path $dataDirectory "dashboard-output.log"
  $stderr = Join-Path $dataDirectory "dashboard-error.log"
  Start-Process -FilePath $nodePath `
    -ArgumentList @("`"$serverPath`"") `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

  $online = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-ReelforgeOnline) {
      $online = $true
      break
    }
  }
  if (-not $online) {
    throw "O painel nao iniciou. Consulte $stderr."
  }
}

if (-not $DoNotOpenBrowser) {
  $edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }
  $chromeCandidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }

  $appBrowser = @(@($edgeCandidates) + @($chromeCandidates)) | Select-Object -First 1
  if ($appBrowser) {
    Start-Process -FilePath $appBrowser -ArgumentList @("--app=$url", "--start-maximized")
  } else {
    Start-Process $url
  }
}
