@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
