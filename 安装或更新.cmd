@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Status.ps1" %*
set "installer_result=%errorlevel%"
if "%~1"=="" pause
exit /b %installer_result%
