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
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
}

function registerScript(directory, node = process.execPath) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$launcher = ${psSingle(path.win32.join(directory, "start-windows.js"))}`,
        `$dir = ${psSingle(directory)}`,
        `$lnk = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${STARTUP_LNK}'`,
        "New-Item -ItemType Directory -Force -Path (Split-Path $lnk) | Out-Null",
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)",
        `$s.TargetPath = ${psSingle(node)}`,
        `$s.Arguments = '"' + $launcher + '"'`,
        "$s.WorkingDirectory = $dir",
        "$s.WindowStyle = 7",
        "$s.Save()",
    ].join("\n");
}

function unregisterTaskScript() {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$name = ${psSingle(WINDOWS_TASK_NAME)}`,
        "$task = Get-ScheduledTask | Where-Object { $_.TaskName -eq $name -and $_.TaskPath -eq '\\' }",
        "if ($task) { $task | Unregister-ScheduledTask -Confirm:$false }",
    ].join("\n");
}

function runPowerShell(script, exec) {
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "inherit",
    });
}

function registerWindowsAutostart(directory, exec = execFileSync) {
    runPowerShell(unregisterTaskScript(), exec);
    runPowerShell(registerScript(directory), exec);
    removeStartupFile(STARTUP_VBS);
}

function unregisterWindowsAutostart(exec = execFileSync) {
    removeStartupFile(STARTUP_LNK);
    removeStartupFile(STARTUP_VBS);
    runPowerShell(unregisterTaskScript(), exec);
}

function launchWindowsApp(directory) {
    return require("./start-windows").launch(directory);
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
        else if (action === "launch") launchWindowsApp(__dirname).catch((err) => {
            console.error(err.message);
            process.exitCode = 1;
        });
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
