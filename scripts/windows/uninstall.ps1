[CmdletBinding()]
param([switch]$RemoveUserData)

$ErrorActionPreference = "Stop"
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
if (-not $installRoot.StartsWith($localAppData, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Diretorio de instalacao inesperado. A desinstalacao foi interrompida."
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$installRoot*dashboard-server.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (-not $RemoveUserData) {
  $answer = Read-Host "Deseja apagar tambem videos, agenda, metricas e credenciais locais? [s/N]"
  $RemoveUserData = $answer -match "^[sS]"
}

if (-not $RemoveUserData) {
  $backupRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) ("Reelforge Backup " + (Get-Date -Format "yyyy-MM-dd-HHmmss"))
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  foreach ($relativePath in @("app\.env", "app\data", "app\library", "app\editor", "app\creative-matrix")) {
    $source = Join-Path $installRoot $relativePath
    if (Test-Path $source) {
      Copy-Item -LiteralPath $source -Destination $backupRoot -Recurse -Force
    }
  }
  Write-Host "Backup criado em $backupRoot" -ForegroundColor Cyan
}

$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Reelforge.lnk"
$startMenuDirectory = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Reelforge"
Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startMenuDirectory -Recurse -Force -ErrorAction SilentlyContinue

$cleanupScript = Join-Path $env:TEMP ("remove-reelforge-" + [guid]::NewGuid().ToString("N") + ".ps1")
@"
Start-Sleep -Seconds 2
Remove-Item -LiteralPath '$($installRoot.Replace("'", "''"))' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath `$MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
"@ | Set-Content -LiteralPath $cleanupScript -Encoding UTF8

Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $cleanupScript) -WindowStyle Hidden
Write-Host "Desinstalacao iniciada." -ForegroundColor Green
