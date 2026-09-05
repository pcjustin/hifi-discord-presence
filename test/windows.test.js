"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { processRoots, stop } = require("../stop-windows");

const directory = String.raw`C:\Music & Apps\Hi-Fi (test)`;
const proc = (ProcessId, Name, CommandLine, ParentProcessId = 1) => ({
    ProcessId, Name, CommandLine, ParentProcessId,
});
const supervisor = proc(10, "cmd.exe", `C:\\Windows\\System32\\cmd.exe /c ""${directory}\\start.bat""`);

test("stopping targets this installation's supervisor, not other apps or command text", () => {
    const processes = [
        supervisor,
        proc(11, "node.exe", "node index.js", 10),
        proc(12, "cloudflared.exe", "cloudflared tunnel --url http://127.0.0.1:47122", 11),
        proc(20, "cmd.exe", 'cmd.exe /c "C:\\other\\start.bat"'),
        proc(21, "node.exe", 'node "C:\\other\\index.js"'),
        proc(22, "node.exe", "node index.js"),
        proc(23, "cloudflared.exe", "cloudflared tunnel --url http://127.0.0.1:47122"),
        proc(24, "cmd.exe", `cmd.exe /c echo "${directory}\\start.bat"`),
        proc(25, "cmd.exe", `cmd.exe /c "${directory}\\start.bat.bak"`),
        proc(26, "powershell.exe", `powershell -Command Write-Output '${directory}\\start.bat'`),
        proc(27, "cmd.exe", `cmd.exe /c "${directory}\\uninstall.bat"`),
        proc(28, "cmd.exe", `cmd.exe /c "${directory}\\install.bat"`),
        proc(29, "cmd.exe", null),
    ];
    assert.deepEqual(processRoots(processes, directory), [10]);
});

test("quoted executables and case differences still identify the launcher", () => {
    const command = `"C:\\Windows\\System32\\cmd.exe" /d /s /c ""${directory.toUpperCase()}\\START.BAT""`;
    assert.deepEqual(processRoots([proc(10, "CMD.EXE", command)], directory), [10]);
});

test("absolute node entry points are stopped once, together with their supervisor", () => {
    const node = proc(11, "node.exe", `"C:\\Program Files\\nodejs\\node.exe" "${directory}\\index.js"`, 10);
    assert.deepEqual(processRoots([supervisor, node], directory), [10]);
    assert.deepEqual(processRoots([node], directory), [11]);
});

test("all duplicate supervisors are stopped with their child processes before restart", () => {
    const calls = [];
    stop(directory, (file, args) => {
        calls.push({ file, args });
        if (file === "powershell.exe") return JSON.stringify([supervisor, { ...supervisor, ProcessId: 30 }]);
    });
    assert.deepEqual(calls.slice(1), [
        { file: "taskkill.exe", args: ["/PID", "10", "/T", "/F"] },
        { file: "taskkill.exe", args: ["/PID", "30", "/T", "/F"] },
    ]);
});

test("stop failures propagate so the installer cannot silently start a duplicate", () => {
    assert.throws(() => stop(directory, (file) => {
        if (file === "powershell.exe") return JSON.stringify(supervisor);
        throw new Error("Access denied");
    }), /Access denied/);
});
