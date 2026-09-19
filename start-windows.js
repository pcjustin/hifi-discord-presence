"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { createHash } = require("crypto");
const { spawn } = require("child_process");

function launch(directory = __dirname, spawnProcess = spawn) {
    const log = fs.openSync(path.join(directory, "hifi-discord.log"), "a");
    try {
        const child = spawnProcess(process.execPath, [path.join(directory, "start-windows.js"), "--supervise"], {
            cwd: directory,
            detached: true,
            windowsHide: true,
            stdio: ["ignore", log, log],
        });
        return new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("spawn", () => {
                child.unref();
                resolve();
            });
        });
    } finally {
        fs.closeSync(log);
    }
}

function supervise(directory = __dirname, spawnProcess = spawn, schedule = setTimeout) {
    const child = spawnProcess(process.execPath, [path.join(directory, "index.js")], {
        cwd: directory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once("error", (err) => console.error("Could not start Hi-Fi Discord Presence:", err.message));
    child.once("close", (code) => {
        console.error("Exited with code " + code + " - restarting in 15s...");
        schedule(() => supervise(directory, spawnProcess, schedule), 15000);
    });
}

if (require.main === module) {
    if (process.argv[2] === "--supervise") {
        const key = createHash("sha256").update(__dirname.toLowerCase()).digest("hex");
        const lock = net.createServer((socket) => socket.end());
        lock.once("error", (err) => {
            if (err.code === "EADDRINUSE") return;
            console.error("Could not start background supervisor:", err.message);
            process.exitCode = 1;
        });
        lock.listen("\\\\.\\pipe\\hifi-discord-" + key, () => supervise());
    } else {
        Promise.resolve().then(() => launch()).catch((err) => {
            console.error("Could not start Hi-Fi Discord Presence:", err.message);
            process.exitCode = 1;
        });
    }
}

module.exports = { launch, supervise };
