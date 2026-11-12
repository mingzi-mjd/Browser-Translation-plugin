@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "asr_exit=%ERRORLEVEL%"
pause
exit /b %asr_exit%
