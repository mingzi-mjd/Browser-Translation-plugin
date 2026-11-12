@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "asr_exit=%ERRORLEVEL%"
if not "%asr_exit%"=="0" pause
exit /b %asr_exit%
