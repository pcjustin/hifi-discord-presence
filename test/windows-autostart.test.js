"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    STARTUP_LNK,
    registerScript,
    unregisterTaskScript,
    registerWindowsAutostart,
    unregisterWindowsAutostart,
} = require("../install-support");

const directory = String.raw`C:\Music & Apps\Hi-Fi (test)`;

test("registerScript creates a Startup .lnk that launches Node.js without a persistent shell", () => {
    const script = registerScript(directory, String.raw`C:\Program Files\nodejs\node.exe`);
    assert.match(script, /CreateShortcut\(\$lnk\)/);
    assert.match(script, new RegExp(STARTUP_LNK.replace(/\./g, "\\.")));
    assert.match(script, /\$launcher = 'C:\\Music & Apps\\Hi-Fi \(test\)\\start-windows\.js'/);
    assert.match(script, /TargetPath = 'C:\\Program Files\\nodejs\\node\.exe'/);
    assert.doesNotMatch(script, /cmd\.exe|start\.bat|--supervise/);
    assert.match(script, /WindowStyle = 7/);
    assert.doesNotMatch(script, /Hidden|powershell\.exe/);
    assert.doesNotMatch(script, /Register-ScheduledTask|schtasks|\.vbs/);
});

test("unregisterTaskScript removes a leftover scheduled task without prompting", () => {
    const script = unregisterTaskScript();
    assert.match(script, /Unregister-ScheduledTask/);
    assert.match(script, /\$name = 'Hi-Fi Discord Presence'/);
    assert.match(script, /Confirm:\$false/);
});

function withStartupFiles(t, names) {
    const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-appdata-"));
    const startup = path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    fs.mkdirSync(startup, { recursive: true });
    const files = {};
    for (const name of names) {
        files[name] = path.join(startup, name);
        fs.writeFileSync(files[name], "legacy");
    }
    t.after(() => fs.rmSync(appdata, { recursive: true, force: true }));
    const previous = process.env.APPDATA;
    process.env.APPDATA = appdata;
    t.after(() => {
        if (previous === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = previous;
    });
    return files;
}

test("registerWindowsAutostart writes the Startup shortcut and clears legacy launchers", (t) => {
    const files = withStartupFiles(t, ["HifiDiscordPresence.vbs"]);
    const calls = [];
    registerWindowsAutostart(directory, (file, args) => {
        calls.push({ file, args });
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, "powershell.exe");
    assert.equal(calls[0].args[3], unregisterTaskScript());
    assert.equal(calls[1].args[3], registerScript(directory));
    assert.equal(fs.existsSync(files["HifiDiscordPresence.vbs"]), false);
});

test("unregisterWindowsAutostart removes Startup launchers and reports task cleanup failure", (t) => {
    const files = withStartupFiles(t, ["HifiDiscordPresence.lnk", "HifiDiscordPresence.vbs"]);
    assert.throws(() => unregisterWindowsAutostart((file, args) => {
        assert.equal(file, "powershell.exe");
        assert.equal(args[3], unregisterTaskScript());
        throw new Error("Access denied");
    }), /Access denied/);
    assert.equal(fs.existsSync(files["HifiDiscordPresence.lnk"]), false);
    assert.equal(fs.existsSync(files["HifiDiscordPresence.vbs"]), false);
});

test("registerScript escapes single quotes in the install path for PowerShell", () => {
    const script = registerScript(String.raw`C:\O'Brien\Hi-Fi`);
    assert.match(script, /\$launcher = 'C:\\O''Brien\\Hi-Fi\\start-windows\.js'/);
});

test("uninstall reports a Startup file that cannot be removed", (t) => {
    const files = withStartupFiles(t, [STARTUP_LNK]);
    fs.unlinkSync(files[STARTUP_LNK]);
    fs.mkdirSync(files[STARTUP_LNK]);
    assert.throws(() => unregisterWindowsAutostart(() => {}), /EISDIR|EPERM/);
});

test("failed legacy cleanup prevents registration of another launcher", (t) => {
    const files = withStartupFiles(t, ["HifiDiscordPresence.vbs"]);
    let calls = 0;
    assert.throws(() => registerWindowsAutostart(directory, () => {
        calls++;
        throw new Error("Access denied");
    }), /Access denied/);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(files["HifiDiscordPresence.vbs"]), true);
});
