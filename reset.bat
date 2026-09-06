@echo off
setlocal
cd /d "%~dp0"
echo Stop BloxFlip MODDED v1.1 before resetting it.
choice /M "Reset all users, balances, history, chat and created community cases"
if errorlevel 2 exit /b 0
where node >nul 2>nul
if errorlevel 1 (
  if exist "data\state.json" del /q "data\state.json"
  if exist "public\local-avatars\*" del /q "public\local-avatars\*"
) else (
  node scripts\reset.js
)
echo Done.
pause
