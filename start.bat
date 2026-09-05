@echo off
rem Supervisor loop: node is restarted if it ever exits. Booting before the network is
rem up, or a crash in a dependency, would otherwise leave nothing to bring the app back.
cd /d "%~dp0"

:loop
node "%~dp0index.js" >> hifi-discord.log 2>&1
echo Exited with code %ERRORLEVEL% - restarting in 15s...>> hifi-discord.log
rem ping, not timeout: timeout.exe aborts when it has no usable console, which is
rem exactly the hidden window the startup launcher runs this in.
ping -n 16 127.0.0.1 >nul
goto loop
