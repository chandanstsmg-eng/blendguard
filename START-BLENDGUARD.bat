@echo off
rem  BlendGuard - SERVER PC (or a single PC that is both server and station).
rem  Station PCs use START-STATION.bat instead: it opens this server, it does not start one.
rem  Starts the server, then opens BlendGuard locked full-screen (kiosk mode):
rem  operators cannot leave it with F11, Alt+Tab to the desktop or close the
rem  window by accident. To exit kiosk mode: Alt+F4, then confirm on Windows.
rem  For a normal window instead (e.g. for setup), run:  START-BLENDGUARD.bat window
title BlendGuard
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
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)

set "BG_WIN=kiosk"
if /i "%~1"=="window" set "BG_WIN=window"

rem Open the station window once the server answers (https when a certificate is set up).
rem Spoken instructions need autoplay without a click, so that browser policy is relaxed for this window only.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command ^
  "$envf = Get-Content .env -ErrorAction SilentlyContinue; $port = ($envf | Select-String '^PORT=(\d+)').Matches.Groups[1].Value; if (-not $port) { $port = 4300 };" ^
  "$scheme = if ($envf | Select-String '^TLS_(PFX|CERT)=\S') { 'https' } else { 'http' };" ^
  "[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true };" ^
  "for ($i=0; $i -lt 180; $i++) { try { Invoke-WebRequest -UseBasicParsing \"${scheme}://localhost:$port/api/health\" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 } };" ^
  "$url = \"${scheme}://localhost:$port\"; $dir = Join-Path $env:LOCALAPPDATA 'BlendGuard\browser';" ^
  "if ('%BG_WIN%' -eq 'kiosk') { $win = @('--kiosk', $url, '--edge-kiosk-type=fullscreen') } else { $win = @(\"--app=$url\", '--start-fullscreen') };" ^
  "Start-Process msedge -ArgumentList ($win + @('--no-first-run', '--autoplay-policy=no-user-gesture-required', '--disable-pinch', '--overscroll-history-navigation=0', \"--user-data-dir=$dir\"))"

rem If BlendGuard stops on an error it is started again (close this window to stop it for good).
:run
call npm start
if errorlevel 1 (
  echo   BlendGuard stopped unexpectedly. Starting it again in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto run
)
pause
