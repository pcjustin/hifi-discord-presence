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
    launchWindowsApp,
} = require("../install-support");

const directory = String.raw`C:\Music & Apps\Hi-Fi (test)`;

test("registerScript creates a Startup .lnk that launches start.bat hidden", () => {
    const script = registerScript(directory);
    assert.match(script, /CreateShortcut\(\$lnk\)/);
    assert.match(script, new RegExp(STARTUP_LNK.replace(/\./g, "\\.")));
    assert.match(script, /\$bat = 'C:\\Music & Apps\\Hi-Fi \(test\)\\start\.bat'/);
    assert.match(script, /TargetPath = 'powershell\.exe'/);
    assert.match(script, /Start-Process -FilePath/);
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
    assert.equal(calls[0].args[3], registerScript(directory));
    assert.equal(calls[1].args[3], unregisterTaskScript());
    assert.equal(fs.existsSync(files["HifiDiscordPresence.vbs"]), false);
});

test("unregisterWindowsAutostart removes Startup launchers even if task cleanup fails", (t) => {
    const files = withStartupFiles(t, ["HifiDiscordPresence.lnk", "HifiDiscordPresence.vbs"]);
    unregisterWindowsAutostart((file, args) => {
        assert.equal(file, "powershell.exe");
        assert.equal(args[3], unregisterTaskScript());
        throw new Error("Access denied");
    });
    assert.equal(fs.existsSync(files["HifiDiscordPresence.lnk"]), false);
    assert.equal(fs.existsSync(files["HifiDiscordPresence.vbs"]), false);
});

test("launchWindowsApp starts start.bat hidden without wscript", () => {
    const calls = [];
    launchWindowsApp(directory, (file, args) => {
        calls.push({ file, args });
    });
    assert.deepEqual(calls, [{
        file: "powershell.exe",
        args: [
            "-NoProfile", "-WindowStyle", "Hidden", "-Command",
            "Start-Process -FilePath 'C:\\Music & Apps\\Hi-Fi (test)\\start.bat' -WindowStyle Hidden",
        ],
    }]);
});

test("registerScript escapes single quotes in the install path for PowerShell", () => {
    const script = registerScript(String.raw`C:\O'Brien\Hi-Fi`);
    assert.match(script, /\$bat = 'C:\\O''Brien\\Hi-Fi\\start\.bat'/);
});
