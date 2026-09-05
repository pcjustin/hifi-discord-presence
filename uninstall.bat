@echo off
cd /d "%~dp0"

set "VBS_FILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HifiDiscordPresence.vbs"

echo Stopping Hi-Fi Discord Presence...
node "%~dp0stop-windows.js"
if errorlevel 1 (
    echo Could not stop this installation. Uninstall stopped.
    pause
    exit /b 1
)

if not exist "%VBS_FILE%" goto :notfound

del "%VBS_FILE%"
echo Removed startup launcher: %VBS_FILE%
goto :done

:notfound
echo Startup launcher was not found - nothing to remove.

:done
echo.
echo Hi-Fi Discord Presence has been stopped and will no longer start when you log in.
echo node_modules, config.json and this project folder were left untouched.
pause
