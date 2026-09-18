"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WINDOWS_TASK_NAME = "Hi-Fi Discord Presence";
const STARTUP_LNK = "HifiDiscordPresence.lnk";
const STARTUP_VBS = "HifiDiscordPresence.vbs";
const CLOUDFLARED_URL =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

function psSingle(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

function startupPath(name) {
    if (!process.env.APPDATA) return null;
    return path.join(
        process.env.APPDATA,
        "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
        name);
}

function removeStartupFile(name) {
    const file = startupPath(name);
    if (!file) return;
    try {
        fs.unlinkSync(file);
    } catch {
        // Absent, or already cleaned up.
    }
}

function registerScript(directory) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$bat = ${psSingle(path.win32.join(directory, "start.bat"))}`,
        `$dir = ${psSingle(directory)}`,
        `$lnk = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${STARTUP_LNK}'`,
        "New-Item -ItemType Directory -Force -Path (Split-Path $lnk) | Out-Null",
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)",
        "$s.TargetPath = 'powershell.exe'",
        `$s.Arguments = '-NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath ''' + ($bat -replace "'", "''") + ''' -WindowStyle Hidden"'`,
        "$s.WorkingDirectory = $dir",
        "$s.WindowStyle = 7",
        "$s.Save()",
    ].join("\n");
}

function unregisterTaskScript() {
    return [
        `$name = ${psSingle(WINDOWS_TASK_NAME)}`,
        "Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue",
    ].join("\n");
}

function runPowerShell(script, exec) {
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
    });
}

function registerWindowsAutostart(directory, exec = execFileSync) {
    runPowerShell(registerScript(directory), exec);
    removeStartupFile(STARTUP_VBS);
    try {
        runPowerShell(unregisterTaskScript(), exec);
    } catch {
        // Older installs may not have left a scheduled task.
    }
}

function unregisterWindowsAutostart(exec = execFileSync) {
    removeStartupFile(STARTUP_LNK);
    removeStartupFile(STARTUP_VBS);
    try {
        runPowerShell(unregisterTaskScript(), exec);
    } catch {
        // Task may already be absent.
    }
}

function launchWindowsApp(directory, exec = execFileSync) {
    const bat = path.win32.join(directory, "start.bat").replace(/'/g, "''");
    exec("powershell.exe", [
        "-NoProfile", "-WindowStyle", "Hidden", "-Command",
        `Start-Process -FilePath '${bat}' -WindowStyle Hidden`,
    ], { windowsHide: true });
}

function plist(node, directory, log, label) {
    const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>${xml(label)}</string>
    <key>ProgramArguments</key><array>
        <string>${xml(node)}</string>
        <string>${xml(path.posix.join(directory, "index.js"))}</string>
    </array>
    <key>WorkingDirectory</key><string>${xml(directory)}</string>
    <key>EnvironmentVariables</key><dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>${xml(log)}</string>
    <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

function cloudflaredOnPath(exec) {
    for (const bin of ["cloudflared.exe", "cloudflared"]) {
        try {
            if (/^cloudflared version /i.test(exec(bin, ["--version"], {
                encoding: "utf8", windowsHide: true, timeout: 10000,
            }).trim())) return true;
        } catch { /* try next */ }
    }
    return false;
}

function installCloudflared(directory, exec = execFileSync) {
    const target = path.join(directory, "cloudflared.exe");
    const valid = (file) => {
        try {
            return /^cloudflared version /i.test(exec(file, ["--version"], {
                encoding: "utf8", windowsHide: true, timeout: 10000,
            }).trim());
        } catch { return false; }
    };
    if (fs.existsSync(target) && valid(target)) return;
    // Prefer PATH only when there is no local binary to shadow it.
    if (!fs.existsSync(target) && cloudflaredOnPath(exec)) return;

    // Resume across install retries: ~55MB is slow on some links.
    const partial = path.join(directory, "cloudflared.exe.partial");
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            exec("curl.exe", ["--fail", "--location", "--connect-timeout", "15", "--max-time", "600",
                "-C", "-", "--output", partial, CLOUDFLARED_URL], {
                stdio: "inherit", windowsHide: true, timeout: 610000,
            });
            if (!valid(partial)) {
                try { fs.unlinkSync(partial); } catch { /* gone */ }
                throw new Error("Downloaded cloudflared did not pass its version check");
            }
            fs.renameSync(partial, target);
            return;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

if (require.main === module) {
    try {
        const [action, ...args] = process.argv.slice(2);
        if (action === "plist" && args.length === 4) process.stdout.write(plist(...args));
        else if (action === "cloudflared") installCloudflared(__dirname);
        else if (action === "autostart") registerWindowsAutostart(__dirname);
        else if (action === "no-autostart") unregisterWindowsAutostart();
        else if (action === "launch") launchWindowsApp(__dirname);
        else throw new Error("Expected plist <node> <directory> <log> <label>, cloudflared, autostart, no-autostart, or launch");
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}

module.exports = {
    WINDOWS_TASK_NAME,
    STARTUP_LNK,
    registerScript,
    unregisterTaskScript,
    registerWindowsAutostart,
    unregisterWindowsAutostart,
    launchWindowsApp,
    plist,
    installCloudflared,
};
