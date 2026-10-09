@echo off
REM Recap-V3 solver - double-click to run. Reads .env (USE_PROXIES on/off + settings).
REM   run.bat          -> normal mode (clean log)
REM   run.bat debug    -> debug mode (full pipeline per request)
cd /d "%~dp0"
node pool-server.mjs %*
echo.
pause
