"use strict";

const path = require("path");
const { execFileSync } = require("child_process");

function processRoots(processes, directory) {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const launcher = escape(path.win32.join(directory, "start.bat"));
    const entry = escape(path.win32.join(directory, "index.js"));
    const executable = '(?:"[^"]+"|\\S+)\\s+';
    const supervisor = new RegExp("^" + executable + '(?:/[dsq]\\s+)*/[ck]\\s+"{0,2}' + launcher + '"{0,2}\\s*$', "i");
    const app = new RegExp("^" + executable + '(?:"' + entry + '"|' + entry + ')\\s*$', "i");
    const roots = processes.filter((proc) =>
        (proc.Name.toLowerCase() === "cmd.exe" && supervisor.test(proc.CommandLine || "")) ||
        (proc.Name.toLowerCase() === "node.exe" && app.test(proc.CommandLine || ""))
    );
    const byId = new Map(processes.map((proc) => [proc.ProcessId, proc]));
    const rootIds = new Set(roots.map((proc) => proc.ProcessId));
    return roots.filter((proc) => {
        const visited = new Set([proc.ProcessId]);
        let parent = proc.ParentProcessId;
        while (byId.has(parent) && !visited.has(parent)) {
            if (rootIds.has(parent)) return false;
            visited.add(parent);
            parent = byId.get(parent).ParentProcessId;
        }
        return true;
    }).map((proc) => proc.ProcessId);
}

function stop(directory, exec = execFileSync) {
    const query = "$ErrorActionPreference = 'Stop'; " +
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " +
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine) | ConvertTo-Json -Compress";
    const output = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
        encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(output.trim() || "[]");
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    // Kill each supervisor together with its children so it cannot restart node.
    for (const pid of processRoots(processes, directory)) {
        exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    }
}

if (require.main === module) {
    try {
        stop(__dirname);
    } catch (err) {
        console.error("Could not stop this installation:", err.message);
        process.exitCode = 1;
    }
}

module.exports = { processRoots, stop };
