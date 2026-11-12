@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-whispercpp.ps1" %*
set "asr_exit=%ERRORLEVEL%"
if not "%asr_exit%"=="0" pause
exit /b %asr_exit%
