[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Reelforge"),
  [switch]$DoNotStart
)

$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $packageRoot

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Green
}

function Assert-SafeInstallDirectory([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
  if (-not $fullPath.StartsWith($localAppData, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Por seguranca, a instalacao deve ficar dentro de LOCALAPPDATA."
  }
  return $fullPath
}

function Install-PrivateNode([string]$Destination) {
  $nodeExe = Join-Path $Destination "node.exe"
  if (Test-Path $nodeExe) {
    return
  }

  Write-Step "Baixando o mecanismo local do sistema"
  $baseUrl = "https://nodejs.org/dist/latest-v22.x"
  $checksums = (Invoke-WebRequest -UseBasicParsing "$baseUrl/SHASUMS256.txt").Content
  $checksumLine = $checksums -split "`n" |
    Where-Object { $_ -match "node-v[0-9.]+-win-x64\.zip$" } |
    Select-Object -First 1
  if (-not $checksumLine) {
    throw "Nao foi possivel localizar a versao oficial do Node.js para Windows."
  }

  $parts = $checksumLine.Trim() -split "\s+"
  $expectedHash = $parts[0].ToUpperInvariant()
  $fileName = $parts[-1]
  $downloadPath = Join-Path $env:TEMP $fileName
  $extractPath = Join-Path $env:TEMP ("reelforge-node-" + [guid]::NewGuid().ToString("N"))

  Invoke-WebRequest -UseBasicParsing "$baseUrl/$fileName" -OutFile $downloadPath
  $actualHash = (Get-FileHash -Algorithm SHA256 $downloadPath).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "A verificacao de seguranca do Node.js falhou."
  }

  New-Item -ItemType Directory -Force -Path $extractPath | Out-Null
  Expand-Archive -LiteralPath $downloadPath -DestinationPath $extractPath -Force
  $extractedRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
  if (-not $extractedRoot) {
    throw "O pacote do Node.js nao foi extraido corretamente."
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $extractedRoot.FullName "*") -Destination $Destination -Recurse -Force
  Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $repoRoot "src\dashboard-server.mjs"))) {
  throw "Pacote incompleto: execute este script dentro do repositorio clonado."
}

$InstallDirectory = Assert-SafeInstallDirectory $InstallDirectory
$appDirectory = Join-Path $InstallDirectory "app"
$runtimeDirectory = Join-Path $InstallDirectory "runtime\node"

Write-Step "Instalando o Reelforge"
New-Item -ItemType Directory -Force -Path $InstallDirectory, $appDirectory | Out-Null

# Copia por lista de permissao: dados de uma instalacao anterior nao sao tocados.
foreach ($relative in @("src", "dashboard", "scripts", "package.json", "package-lock.json", ".env.example")) {
  $source = Join-Path $repoRoot $relative
  if (Test-Path $source) {
    Copy-Item -Path $source -Destination $appDirectory -Recurse -Force
  }
}
Copy-Item -LiteralPath (Join-Path $packageRoot "start-app.ps1") -Destination (Join-Path $InstallDirectory "start-app.ps1") -Force
Copy-Item -LiteralPath (Join-Path $packageRoot "configure.ps1") -Destination (Join-Path $InstallDirectory "configure.ps1") -Force
Copy-Item -LiteralPath (Join-Path $packageRoot "uninstall.ps1") -Destination (Join-Path $InstallDirectory "uninstall.ps1") -Force

foreach ($relativeDirectory in @(
  "data",
  "library\raw",
  "library\final",
  "library\covers",
  "editor\music",
  "editor\outputs",
  "editor\proof",
  "editor\temp",
  "editor\transcription",
  "editor\sfx",
  "creative-matrix\normalized",
  "creative-matrix\outputs",
  "creative-matrix\pieces",
  "creative-matrix\temp",
  "remix\sources",
  "models\transformers"
)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $appDirectory $relativeDirectory) | Out-Null
}

$envPath = Join-Path $appDirectory ".env"
if (-not (Test-Path $envPath)) {
  Copy-Item -LiteralPath (Join-Path $appDirectory ".env.example") -Destination $envPath
}

Install-PrivateNode $runtimeDirectory

Write-Step "Instalando os componentes de video e IA"
$npmCommand = Join-Path $runtimeDirectory "npm.cmd"
if (-not (Test-Path $npmCommand)) {
  throw "npm nao foi encontrado no mecanismo local."
}
$env:npm_config_cache = Join-Path $InstallDirectory "npm-cache"
Push-Location $appDirectory
try {
  & $npmCommand ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw "A instalacao das dependencias falhou com o codigo $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

Write-Step "Criando atalhos"
$powershellPath = Join-Path $PSHOME "powershell.exe"
$startScript = Join-Path $InstallDirectory "start-app.ps1"
$configureScript = Join-Path $InstallDirectory "configure.ps1"
$uninstallScript = Join-Path $InstallDirectory "uninstall.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Reelforge"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$shell = New-Object -ComObject WScript.Shell

function New-ReelforgeShortcut([string]$Path, [string]$Script, [string]$Description) {
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $powershellPath
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`""
  $shortcut.WorkingDirectory = $InstallDirectory
  $shortcut.Description = $Description
  $appIcon = Join-Path $appDirectory "dashboard\public\favicon.ico"
  $shortcut.IconLocation = if (Test-Path $appIcon) { $appIcon } else { "$env:SystemRoot\System32\shell32.dll,220" }
  $shortcut.Save()
}

New-ReelforgeShortcut (Join-Path $desktop "Reelforge.lnk") $startScript "Abrir o Reelforge"
New-ReelforgeShortcut (Join-Path $startMenu "Reelforge.lnk") $startScript "Abrir o Reelforge"
New-ReelforgeShortcut (Join-Path $startMenu "Configurar Instagram.lnk") $configureScript "Configurar a integracao do Instagram"
New-ReelforgeShortcut (Join-Path $startMenu "Desinstalar.lnk") $uninstallScript "Desinstalar o Reelforge"

@{
  installedAt = (Get-Date).ToString("o")
  installDirectory = $InstallDirectory
  version = "1.0.0"
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallDirectory "install-info.json") -Encoding UTF8

Write-Host "`nInstalacao concluida." -ForegroundColor Cyan
Write-Host "O sistema foi instalado em: $InstallDirectory"
Write-Host "As credenciais comecam vazias e pertencem somente ao usuario deste computador."

if (-not $DoNotStart) {
  & $startScript
}
