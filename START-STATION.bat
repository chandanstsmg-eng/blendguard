@echo off
rem  BlendGuard - mixing STATION PC. Put a shortcut to this file in the station's
rem  Startup folder. It does NOT run a server or a database: it opens the
rem  BlendGuard server on the plant network, locked full-screen (kiosk), and starts
rem  the scale bridge so this PC's scale reaches the server.
rem
rem  Set SERVER below (and the bridge settings in START-SCALE-BRIDGE.bat).
rem  Use https://... once the server has a certificate (needed for fingerprint/face).
rem  For a normal window during set-up:  START-STATION.bat window

set "SERVER=http://192.168.1.20:4300"

title BlendGuard station
cd /d "%~dp0"

set "BG_WIN=kiosk"
if /i "%~1"=="window" set "BG_WIN=window"

rem Scale bridge in its own minimised window, unless it has not been set up yet.
findstr /c:"paste-the-bridge-key-here" START-SCALE-BRIDGE.bat >nul
if errorlevel 1 (
  start "BlendGuard scale bridge" /min cmd /c START-SCALE-BRIDGE.bat
) else (
  echo   Scale bridge not set up yet: see START-SCALE-BRIDGE.bat.
)

rem Wait for the server, then open the station screen. Spoken instructions need
rem autoplay without a click, so that browser policy is relaxed for this window only.
powershell -NoProfile -WindowStyle Hidden -Command ^
  "$url = '%SERVER%';" ^
  "for ($i=0; $i -lt 300; $i++) { try { Invoke-WebRequest -UseBasicParsing \"$url/api/health\" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 2 } };" ^
  "$dir = Join-Path $env:LOCALAPPDATA 'BlendGuard\browser';" ^
  "if ('%BG_WIN%' -eq 'kiosk') { $win = @('--kiosk', $url, '--edge-kiosk-type=fullscreen') } else { $win = @(\"--app=$url\", '--start-fullscreen') };" ^
  "Start-Process msedge -ArgumentList ($win + @('--no-first-run', '--autoplay-policy=no-user-gesture-required', '--disable-pinch', '--overscroll-history-navigation=0', \"--user-data-dir=$dir\"))"
