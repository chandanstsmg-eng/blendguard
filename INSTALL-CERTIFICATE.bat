@echo off
rem  BlendGuard - run ONCE on each station / scientist PC, as administrator
rem  (right-click > Run as administrator), with blendguard.cer from the server's
rem  data\tls folder in the same folder as this file. Afterwards this PC trusts the
rem  BlendGuard server's HTTPS address, which fingerprint / face sign-in needs.
cd /d "%~dp0"
set "CER=blendguard.cer"
if not exist "%CER%" set "CER=data\tls\blendguard.cer"
if not exist "%CER%" (
  echo.
  echo   blendguard.cer not found. Copy it from the server's data\tls folder next to this file.
  echo.
  pause
  exit /b 1
)
certutil -addstore -f Root "%CER%"
if errorlevel 1 (
  echo.
  echo   Could not install. Right-click this file and choose "Run as administrator".
) else (
  echo.
  echo   Done. Restart Edge on this PC.
)
echo.
pause
