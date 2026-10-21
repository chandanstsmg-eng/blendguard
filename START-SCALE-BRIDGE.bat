@echo off
rem  BlendGuard scale bridge - runs on a STATION PC whose METTLER TOLEDO scale is
rem  plugged into this PC by USB. It reads the scale and sends every reading to
rem  the BlendGuard server. START-STATION.bat starts it automatically.
rem
rem  1. Setup -> Station setup -> (this station) -> Scale settings:
rem     "Into the station PC", the COM port, baud rate and data format.
rem  2. Setup -> Station setup -> Create bridge key, and copy the three values below.
rem  3. To see this PC's COM ports:  START-SCALE-BRIDGE.bat list

set "SERVER=http://192.168.1.20:4300"
set "STATION=ST-01"
set "KEY=paste-the-bridge-key-here"

title BlendGuard scale bridge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo   First start: installing, this takes a few minutes...
  call npm install --omit=dev
  if errorlevel 1 ( pause & exit /b 1 )
)

if /i "%~1"=="list" (
  call npx tsx scripts\scale-bridge.ts --list
  pause
  exit /b 0
)

:run
call npx tsx scripts\scale-bridge.ts --server "%SERVER%" --station "%STATION%" --key "%KEY%"
echo   The bridge stopped. Starting it again in 5 seconds (close this window to stop it)...
timeout /t 5 /nobreak >nul
goto run
