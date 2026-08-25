@echo off
cd /d "%~dp0"

set "VBS_FILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HifiDiscordPresence.vbs"

rem The supervisor cmd.exe has to die before node, or it just restarts it 15s later.
rem Processes are matched on their command line, not their image name: node.exe and
rem cloudflared.exe are ordinary names the user may well be running for something else,
rem and cloudflared is a child of node that Windows does not reap with its parent.
echo Stopping Hi-Fi Discord Presence...
powershell -NoProfile -Command "$all = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*start.bat*' -or $_.CommandLine -like '*index.js*' -or $_.CommandLine -like '*47122*' }; $all | Where-Object { $_.Name -eq 'cmd.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $all | Where-Object { $_.Name -ne 'cmd.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

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
