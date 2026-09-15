@echo off
setlocal
title Helmsman Release Publisher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Publish-Helmsman.ps1" %*
set "HELMSMAN_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%HELMSMAN_EXIT_CODE%"=="0" echo Helmsman publishing stopped with exit code %HELMSMAN_EXIT_CODE%.
pause
exit /b %HELMSMAN_EXIT_CODE%
