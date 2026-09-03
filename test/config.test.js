"use strict";

// Loading index.js starts the whole app, so the modules it talks to are stubbed out.
// Each case gets its own copy of the app in its own directory, because a different path
// is a different module instance - the only way to run the config check twice.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fakes = {
    "@xhayper/discord-rpc": {
        Client: class {
            on() {}
            login() {
                return Promise.resolve();
            }
        },
    },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    http: {
        createServer: () => ({ listen() {}, on() {} }),
        get: () => ({ on() {} }),
    },
    child_process: {
        spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {} }),
    },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.call(this, request, ...rest);
};

function launch(configText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-discord-config-"));
    const root = path.join(__dirname, "..");
    fs.mkdirSync(path.join(dir, "sources"));
    for (const f of ["index.js", "presence.js", "sources/foobar2000.js"]) {
        fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    if (configText !== null) fs.writeFileSync(path.join(dir, "config.json"), configText);

    const messages = [];
    const realLog = console.log;
    const realError = console.error;
    const realExit = process.exit;
    console.log = () => {};
    console.error = (...args) => messages.push(args.join(" "));
    process.exit = (code) => {
        const stop = new Error("process.exit");
        stop.exitCode = code;
        throw stop;
    };

    let exitCode = null;
    try {
        require(path.join(dir, "index.js"));
    } catch (err) {
        if (err.exitCode === undefined) throw err;
        exitCode = err.exitCode;
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exit = realExit;
    }
    return { exitCode, output: messages.join("\n") };
}

const good = { source: "foobar2000", discordClientId: "123" };

test("a missing config.json is reported, not thrown as a stack trace", () => {
    const { exitCode, output } = launch(null);
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Could not read .*config\.json/);
    assert.match(output, /config\.example\.json/);
});

test("an unparseable config.json is reported, not thrown as a stack trace", () => {
    const { exitCode, output } = launch("{ not json");
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Could not read .*config\.json/);
});

test("a config.json saved with a BOM still loads", () => {
    const { exitCode, output } = launch("﻿" + JSON.stringify(good));
    assert.strictEqual(exitCode, null, "rejected a config file Notepad would happily produce: " + output);
});

test("the placeholder Discord ID gets its own message", () => {
    const { exitCode, output } = launch(JSON.stringify({ ...good, discordClientId: "YOUR_DISCORD_APPLICATION_ID" }));
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Set discordClientId/);
});

test("per-source Discord IDs enable multi-source mode without a source setting", () => {
    // Only foobar2000 is enabled here because this config test copies only that source;
    // empty/placeholder entries deliberately mean "do not start this listener".
    const { exitCode, output } = launch(JSON.stringify({
        discordClientIds: {
            foobar2000: "111",
            roon: "YOUR_DISCORD_APPLICATION_ID",
            upnp: "",
        },
    }));
    assert.strictEqual(exitCode, null, output);
});

test("multi-source mode requires at least one real Discord ID", () => {
    const { exitCode, output } = launch(JSON.stringify({
        discordClientIds: {
            foobar2000: "YOUR_DISCORD_APPLICATION_ID",
            roon: "",
            upnp: "",
        },
    }));
    assert.strictEqual(exitCode, 1);
    assert.match(output, /at least one ID in discordClientIds/);
});

test("a misspelled per-source key is reported before it can be required", () => {
    const { exitCode, output } = launch(JSON.stringify({ discordClientIds: { roobar2000: "111" } }));
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Unknown source.*roobar2000/);
    assert.match(output, /foobar2000, roon, upnp/);
});

test("a missing or unknown source names the ones that exist", () => {
    // A typo here would otherwise surface as MODULE_NOT_FOUND from a require of a path
    // the user never wrote.
    for (const source of [undefined, "spotify", "../etc/passwd"]) {
        const { exitCode, output } = launch(JSON.stringify({ ...good, source }));
        assert.strictEqual(exitCode, 1, "accepted source " + source);
        assert.match(output, /foobar2000, roon, upnp/);
    }
});
