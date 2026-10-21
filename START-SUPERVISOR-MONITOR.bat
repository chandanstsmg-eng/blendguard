@echo off
rem  BlendGuard - scientist floor monitor.
rem  Run this on the control-room / office PC (not on a mixing station).
rem  It does NOT start a server: it opens the BlendGuard server that is already
rem  running on the plant network, full-screen, ready for a scientist to sign in.
rem
rem  Usage:  START-SUPERVISOR-MONITOR.bat               (server on this PC)
rem          START-SUPERVISOR-MONITOR.bat 192.168.1.20  (server on another PC)
title BlendGuard - Scientist floor monitor
cd /d "%~dp0"

set "BG_HOST=%~1"
if "%BG_HOST%"=="" set "BG_HOST=localhost"
set "BG_PORT=4300"
for /f "tokens=2 delims==" %%p in ('findstr /b "PORT=" .env 2^>nul') do set "BG_PORT=%%p"

start "" msedge --app=http://%BG_HOST%:%BG_PORT%/supervisor/monitor --start-fullscreen --no-first-run --autoplay-policy=no-user-gesture-required --user-data-dir="%LOCALAPPDATA%\BlendGuard\monitor"
