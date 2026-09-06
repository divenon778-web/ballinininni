@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer first.
  pause
  exit /b 1
)
echo.
echo Starting BloxFlip MODDED v1.1 for your local network...
echo Friends on the same Wi-Fi/LAN can use: http://YOUR_IPV4:3000
echo Your IPv4 addresses:
ipconfig | findstr /i "IPv4"
echo.
set HOST=0.0.0.0
node server.js
pause
