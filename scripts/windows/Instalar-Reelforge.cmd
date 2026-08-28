@echo off
setlocal
title Instalador do Reelforge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo A instalacao nao foi concluida. Consulte a mensagem acima.
  pause
)
endlocal
