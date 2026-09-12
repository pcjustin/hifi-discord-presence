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
    let queries = 0;
    stop(directory, (file, args) => {
        calls.push({ file, args });
        if (file === "powershell.exe") return JSON.stringify(queries++ ? [] : [supervisor, { ...supervisor, ProcessId: 30 }]);
    });
    assert.equal(queries, 2);
    assert.deepEqual(calls.filter((call) => call.file === "taskkill.exe"), [
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

test("dedicated manual supervisors are identifiable even during their restart delay", () => {
    const command = `"C:\\Windows\\System32\\cmd.exe" /d /s /c ""${directory}\\start.bat" --supervise"`;
    assert.deepEqual(processRoots([proc(10, "cmd.exe", command)], directory), [10]);
});

test("orphan tunnels are matched by exact local executable, not a shared port or path prefix", () => {
    const processes = [
        proc(10, "cloudflared.exe", `"${directory}\\cloudflared.exe" tunnel --url http://127.0.0.1:47122`, 999),
        { ...proc(11, "cloudflared.exe", null), ExecutablePath: `${directory}\\cloudflared.exe` },
        proc(12, "cloudflared.exe", 'cloudflared tunnel --url http://127.0.0.1:47122'),
        proc(13, "cloudflared.exe", `"${directory}-other\\cloudflared.exe" tunnel`),
        proc(14, "cloudflared.exe", `cloudflared tunnel --config "${directory}\\cloudflared.exe"`),
    ];
    assert.deepEqual(processRoots(processes, directory), [10, 11]);
});

function simulate(snapshots, kill = () => {}) {
    const calls = [];
    let query = 0;
    stop(directory, (file, args) => {
        if (file === "powershell.exe") return JSON.stringify(snapshots[Math.min(query++, snapshots.length - 1)]);
        calls.push(args);
        return kill(args);
    });
    return calls;
}

test("a PATH tunnel surviving its parent is stopped on the verification pass", () => {
    const node = proc(11, "node.exe", `node "${directory}\\index.js"`, 10);
    const tunnel = proc(12, "cloudflared.exe", "cloudflared tunnel", 11);
    assert.deepEqual(simulate([[supervisor, node, tunnel], [tunnel], []]), [
        ["/PID", "10", "/T", "/F"],
        ["/PID", "12", "/T", "/F"],
    ]);
});

test("processes that exit before taskkill are treated as successfully stopped", () => {
    assert.doesNotThrow(() => simulate([[supervisor], []], () => { throw new Error("not found"); }));
});

test("successful taskkill output is insufficient if processes remain", () => {
    assert.throws(() => simulate([[supervisor]]), /Processes still running: 10/);
});

test("verification catches a newly restarted node", () => {
    const node = proc(11, "node.exe", `node "${directory}\\index.js"`);
    assert.deepEqual(simulate([[supervisor], [node], []]), [
        ["/PID", "10", "/T", "/F"], ["/PID", "11", "/T", "/F"],
    ]);
});

test("remembered descendant PIDs do not target a replacement process", () => {
    const tunnel = { ...proc(12, "cloudflared.exe", "cloudflared tunnel", 10), CreationDate: "old" };
    const replacement = { ...tunnel, CreationDate: "new", ParentProcessId: 1 };
    assert.deepEqual(simulate([[supervisor, tunnel], [replacement]]), [["/PID", "10", "/T", "/F"]]);
});

test("legacy interactive loops stop before node without killing unrelated sibling jobs", () => {
    const shell = proc(9, "cmd.exe", '"C:\\Windows\\System32\\cmd.exe"');
    const node = proc(11, "node.exe", `node "${directory}\\index.js"`, 9);
    const sibling = proc(20, "node.exe", "node other.js", 9);
    assert.deepEqual(simulate([[shell, node, sibling], [shell, sibling], [sibling]]), [
        ["/PID", "9", "/F"], ["/PID", "11", "/T", "/F"], ["/PID", "9", "/F"],
    ]);
});
