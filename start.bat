@echo off
setlocal
node "%~dp0start-windows.js"
if errorlevel 1 (
    echo Could not start Hi-Fi Discord Presence. See the error above.
    pause
    exit /b 1
)
exit /b 0
