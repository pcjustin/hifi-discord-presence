@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    where winget >nul 2>nul
    if errorlevel 1 (
        echo Node.js was not found on your PATH, and winget is not available to install it automatically.
        echo Please install Node.js LTS from https://nodejs.org/ and re-run this script.
        pause
        exit /b 1
    )
    echo Node.js was not found. Installing it now via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo Automatic Node.js install failed. Please install it manually from https://nodejs.org/ and re-run this script.
        pause
        exit /b 1
    )
    rem cmd.exe fixes its environment when the window opens, so winget's PATH update is
    rem invisible to this one. Adding winget's own install location is what lets the rest
    rem of the script run now instead of asking for a second run.
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
    where node >nul 2>nul
    if errorlevel 1 (
        echo Node.js installed, but not where this script expected it.
        echo Please close this window and re-run install.bat so the updated PATH takes effect.
        echo If this message keeps repeating, winget may have opened the Microsoft Store instead of installing -
        echo install "App Installer" from the Store first, then try again.
        pause
        exit /b 0
    )
    echo Node.js installed.
)

if not exist "%~dp0config.json" (
    copy /y "%~dp0config.example.json" "%~dp0config.json" >nul
    echo Created config.json from the example. Open it and fill in "discordClientIds".
)

echo Installing npm dependencies, this may take a minute...
call npm install
if errorlevel 1 (
    echo npm install failed - see the errors above.
    pause
    exit /b 1
)

if not exist "%~dp0cloudflared.exe" (
    where curl >nul 2>nul
    if errorlevel 1 (
        echo WARNING: curl was not found, so cloudflared.exe could not be downloaded.
        echo Track title/artist will still work, but cover art needs cloudflared.exe next to this script.
        echo Download it yourself from https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
        echo and save it as "%~dp0cloudflared.exe", then re-run this script.
    ) else (
        echo Downloading cloudflared for cover art support...
        curl.exe -L -o "%~dp0cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        if errorlevel 1 (
            echo WARNING: cloudflared download failed. Track title/artist will still work, but cover art will not.
        )
    )
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

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_FILE=%STARTUP_DIR%\HifiDiscordPresence.vbs"

if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%"

echo Creating startup launcher...
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_FILE%"
echo WshShell.Run """%INSTALL_DIR%\start.bat""", 0, False >> "%VBS_FILE%"

echo Starting Hi-Fi Discord Presence now...
wscript.exe "%VBS_FILE%"

echo.
echo Setup complete. It will now start automatically every time you log into Windows.
echo Log file: %INSTALL_DIR%\hifi-discord.log
echo Edit config.json and re-run this script after changing Discord Application IDs or source settings.
pause
