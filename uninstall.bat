@echo off
setlocal
set "INSTALL_DIR=%~dp0"
cd /d "%TEMP%"

echo Stopping Hi-Fi Discord Presence...
node "%INSTALL_DIR%stop-windows.js"
if errorlevel 1 (
    echo Could not stop this installation. Uninstall stopped.
    pause
    exit /b 1
)

echo Removing the Startup shortcut...
node "%INSTALL_DIR%install-support.js" no-autostart
if errorlevel 1 (
    echo Could not remove the Startup shortcut. Uninstall stopped.
    pause
    exit /b 1
)
echo Removed Startup shortcut and any leftover launchers.

echo.
echo Hi-Fi Discord Presence has been stopped and will no longer start when you log in.
echo node_modules, config.json and this project folder were left untouched.
pause
