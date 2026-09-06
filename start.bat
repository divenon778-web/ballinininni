@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)
echo.
echo Starting BloxFlip MODDED v1.1...
echo Open: http://localhost:3000
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://localhost:3000'"
node server.js
echo.
echo Server stopped.
pause
