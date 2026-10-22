@echo off
setlocal
cd /d "%~dp0"

where winget >nul 2>nul
if errorlevel 1 (
    echo winget is not available to install or update Node.js LTS.
    echo Please install Node.js LTS from https://nodejs.org/ and re-run this script.
    pause
    exit /b 1
)
echo Installing or updating Node.js LTS through winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo Automatic Node.js install or update failed. Please install Node.js LTS manually and re-run this script.
    pause
    exit /b 1
)
rem Prefer winget's Node.js install over older copies earlier on PATH.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
if not exist "%ProgramFiles%\nodejs\node.exe" (
    echo Node.js was installed, but not in the expected winget location.
    echo Please check the installation and re-run install.bat.
    pause
    exit /b 1
)
node --version

if not exist "%~dp0config.json" (
    copy /y "%~dp0config.example.json" "%~dp0config.json" >nul
    echo Created config.json from the example. Open it and fill in "discordClientIds".
)

echo Stopping the previous Hi-Fi Discord Presence instance...
node "%~dp0stop-windows.js"
if errorlevel 1 (
    echo Could not stop the previous instance. Installation stopped.
    pause
    exit /b 1
)

echo Installing npm dependencies, this may take a minute...
call npm ci --ignore-scripts
if errorlevel 1 (
    echo npm ci failed - see the errors above.
    pause
    exit /b 1
)

echo Checking cloudflared for cover art support...
node "%~dp0install-support.js" cloudflared
if errorlevel 1 (
    echo WARNING: cloudflared setup failed. Re-run install.bat to retry.
    echo Track title/artist will still work, but cover art needs a working cloudflared.exe.
)

findstr /c:"YOUR_DISCORD_APPLICATION_ID" "%~dp0config.json" >nul 2>nul
if not errorlevel 1 (
    echo.
    echo NOTE: A placeholder Discord Application ID disables that source.
    echo Make sure at least one entry in discordClientIds contains a real ID.
    echo See README.md for instructions.
)

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

echo Creating the Startup shortcut...
node "%~dp0install-support.js" autostart
if errorlevel 1 (
    echo Could not create the Startup shortcut. Installation stopped.
    pause
    exit /b 1
)

echo Starting Hi-Fi Discord Presence now...
node "%~dp0install-support.js" launch
if errorlevel 1 (
    echo Could not start the app. Re-run install.bat, or start it manually with start.bat.
    pause
    exit /b 1
)

echo.
echo Setup complete. It will now start automatically every time you log into Windows.
echo Log file: %INSTALL_DIR%\hifi-discord.log
echo Edit config.json and re-run this script after changing Discord Application IDs or source settings.
pause
