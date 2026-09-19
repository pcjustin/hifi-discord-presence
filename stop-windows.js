"use strict";

const path = require("path");
const { execFileSync } = require("child_process");

function processRoots(processes, directory) {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const launcher = escape(path.win32.join(directory, "start.bat"));
    const entry = escape(path.win32.join(directory, "index.js"));
    const backgroundEntry = escape(path.win32.join(directory, "start-windows.js"));
    const executable = '(?:"[^"]+"|\\S+)\\s+';
    const supervisor = new RegExp("^" + executable + '(?:/[dsq]\\s+)*/[ck]\\s+"{0,2}' + launcher + '"{0,2}(?:\\s+--supervise"?)?\\s*$', "i");
    const app = new RegExp("^" + executable + '(?:"' + entry + '"|' + entry + ')\\s*$', "i");
    const background = new RegExp("^" + executable + '(?:"' + backgroundEntry + '"|' + backgroundEntry + ')\\s+--supervise\\s*$', "i");
    const tunnelPath = path.win32.join(directory, "cloudflared.exe").toLowerCase();
    const localTunnel = (proc) => {
        const first = /^(?:"([^"]+)"|(\S+))/.exec(proc.CommandLine || "");
        const binary = proc.ExecutablePath || (first && (first[1] || first[2]));
        return binary && path.win32.normalize(binary).toLowerCase() === tunnelPath;
    };
    const roots = processes.filter((proc) =>
        (proc.Name.toLowerCase() === "cmd.exe" && supervisor.test(proc.CommandLine || "")) ||
        (proc.Name.toLowerCase() === "node.exe" && (app.test(proc.CommandLine || "") || background.test(proc.CommandLine || ""))) ||
        (proc.Name.toLowerCase() === "cloudflared.exe" && localTunnel(proc))
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
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath, CreationDate) | ConvertTo-Json -Compress";
    const known = new Set();
    const knownLegacyShells = new Set();
    const identity = (proc) => JSON.stringify([proc.ProcessId, proc.CreationDate, proc.Name, proc.CommandLine]);
    let lastError;
    for (let attempt = 0; attempt <= 5; attempt++) {
        const output = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            (attempt ? "Start-Sleep -Milliseconds 200; " : "") + query], {
            encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        });
        const parsed = JSON.parse(output.trim() || "[]");
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        const roots = processRoots(processes, directory);
        const selected = new Set(roots);
        const legacyShells = processes.filter((proc) =>
            knownLegacyShells.has(identity(proc)) || (proc.Name.toLowerCase() === "cmd.exe" &&
            /^(?:"[^"]*cmd\.exe"|\S*cmd\.exe)\s*$/i.test(proc.CommandLine || "") &&
            processes.some((child) => child.ParentProcessId === proc.ProcessId &&
                child.Name.toLowerCase() === "node.exe" && roots.includes(child.ProcessId)))
        );
        const legacyIds = new Set(legacyShells.map((proc) => proc.ProcessId));
        for (const shell of legacyShells) {
            knownLegacyShells.add(identity(shell));
            selected.add(shell.ProcessId);
        }
        for (const proc of processes) {
            if (known.has(identity(proc))) selected.add(proc.ProcessId);
        }
        // Remember descendants before killing parents, including PATH-installed tunnels.
        let previousSize;
        do {
            previousSize = selected.size;
            for (const proc of processes) {
                if (selected.has(proc.ParentProcessId) && !legacyIds.has(proc.ParentProcessId)) selected.add(proc.ProcessId);
            }
        } while (selected.size !== previousSize);
        const remaining = processes.filter((proc) => selected.has(proc.ProcessId));
        if (!remaining.length) return;
        if (attempt === 5) {
            throw new Error("Processes still running: " + remaining.map((proc) => proc.ProcessId).join(", ") +
                (lastError ? ". " + lastError.message : ""));
        }
        for (const proc of remaining) known.add(identity(proc));
        // Older start.bat versions ran inside the caller's shell. Stop that loop without
        // killing unrelated sibling processes launched from the same shell.
        const byId = new Map(processes.map((proc) => [proc.ProcessId, proc]));
        const targets = remaining.filter((proc) => {
            const visited = new Set([proc.ProcessId]);
            let parent = proc.ParentProcessId;
            while (byId.has(parent) && !visited.has(parent)) {
                if (selected.has(parent) && !legacyIds.has(parent)) return false;
                visited.add(parent);
                parent = byId.get(parent).ParentProcessId;
            }
            return true;
        }).sort((a, b) => Number(legacyIds.has(b.ProcessId)) - Number(legacyIds.has(a.ProcessId)));
        for (const proc of targets) {
            try {
                const args = ["/PID", String(proc.ProcessId)];
                if (!legacyIds.has(proc.ProcessId)) args.push("/T");
                exec("taskkill.exe", [...args, "/F"], { windowsHide: true });
            } catch (err) {
                // A parent tree kill may already have removed this PID; verify by querying again.
                lastError = err;
            }
        }
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
