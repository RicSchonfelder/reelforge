[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $installRoot "app\.env"
$examplePath = Join-Path $installRoot "app\.env.example"

if (-not (Test-Path $envPath)) {
  Copy-Item -LiteralPath $examplePath -Destination $envPath
}

function Read-EnvFile([string]$Path) {
  $values = [ordered]@{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
      $values[$matches[1]] = $matches[2]
    }
  }
  return $values
}

function ConvertFrom-SecureValue([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$settings = Read-EnvFile $envPath
Write-Host "Configuracao local do Instagram" -ForegroundColor Green
Write-Host "A senha e o codigo 2FA nunca devem ser informados aqui."

$igUserId = Read-Host "IG User ID [$($settings['IG_USER_ID'])]"
if ($igUserId) { $settings["IG_USER_ID"] = $igUserId.Trim() }

$secureToken = Read-Host "Access token (fica oculto; Enter preserva o atual)" -AsSecureString
$plainToken = ConvertFrom-SecureValue $secureToken
if ($plainToken) { $settings["IG_ACCESS_TOKEN"] = $plainToken.Trim() }

$timeZone = Read-Host "Fuso horario [$($settings['POSTING_TIME_ZONE'])]"
if ($timeZone) { $settings["POSTING_TIME_ZONE"] = $timeZone.Trim() }

$slots = Read-Host "Horarios separados por virgula [$($settings['POSTING_SLOTS'])]"
if ($slots) { $settings["POSTING_SLOTS"] = $slots.Trim() }

$orderedKeys = @(
  "IG_USER_ID",
  "IG_ACCESS_TOKEN",
  "META_API_VERSION",
  "FFPROBE_PATH",
  "SCHEDULER_INTERVAL_SECONDS",
  "AUTO_SCHEDULE_ENABLED",
  "DAILY_POST_LIMIT",
  "POSTING_TIME_ZONE",
  "POSTING_SLOTS",
  "CLOUDFLARED_PATH"
)
# Chaves conhecidas primeiro, na ordem; chaves desconhecidas (REELFORGE_TOKEN,
# NOTIFY_*, RETENTION_DAYS, etc.) sao PRESERVADAS — antes este script apagava
# qualquer chave fora da lista, inclusive o token de seguranca da rede.
$unknownKeys = @($settings.Keys | Where-Object { $orderedKeys -notcontains $_ } | Sort-Object)
$lines = foreach ($key in ($orderedKeys + $unknownKeys)) {
  "$key=$($settings[$key])"
}
$lines | Set-Content -LiteralPath $envPath -Encoding UTF8
$plainToken = $null

Write-Host "`nConfiguracao salva somente neste computador." -ForegroundColor Cyan
Write-Host "Feche e abra novamente o Reelforge para aplicar as alteracoes."
Read-Host "Pressione Enter para concluir"
