"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
    // Keep staging on the destination volume so replacement uses an atomic rename.
    const staging = fs.mkdtempSync(path.join(directory, "cloudflared-download-"));
    const download = path.join(staging, "cloudflared.exe");
    try {
        exec("curl.exe", ["--fail", "--location", "--connect-timeout", "15", "--max-time", "120",
            "--output", download,
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"], {
            stdio: "inherit", windowsHide: true, timeout: 130000,
        });
        if (!valid(download)) throw new Error("Downloaded cloudflared did not pass its version check");
        fs.renameSync(download, target);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        const [action, ...args] = process.argv.slice(2);
        if (action === "plist" && args.length === 4) process.stdout.write(plist(...args));
        else if (action === "cloudflared") installCloudflared(__dirname);
        else throw new Error("Expected plist <node> <directory> <log> <label>, or cloudflared");
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}

module.exports = { plist, installCloudflared };
