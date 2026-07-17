@echo off
REM Windows double-clickable launcher: restarts the tutor server.
REM To put it on your Desktop: right-click this file -> Send to -> Desktop
REM (create shortcut), or right-click -> Create shortcut and move it.
cd /d "%~dp0"
node scripts\restart.mjs
echo.
echo Server stopped. Press any key to close this window.
pause >nul
