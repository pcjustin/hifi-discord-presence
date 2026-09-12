"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function setup() {
    const server = new EventEmitter();
    const children = [];
    const timers = new Set();
    let ready;
    let exitCode;
    server.listen = (_port, _host, callback) => { ready = callback; };
    const fakes = {
        fs: { existsSync: () => true },
        http: { createServer: () => server },
        "discord-api-types/v10": { ActivityType: {} },
        child_process: {
            spawn() {
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.kill = () => { child.killed = true; child.emit("exit", 1); };
                children.push(child);
                return child;
            },
        },
    };
    const context = {
        require: (name) => fakes[name] || require(name),
        module: { exports: {} },
        __dirname: path.join(__dirname, ".."),
        process: { platform: "win32", exit: (code) => { exitCode = code; } },
        console: { log() {}, error() {} },
        setTimeout: (callback) => { timers.add(callback); return callback; },
        clearTimeout: (callback) => timers.delete(callback),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "presence.js"), "utf8"), context);
    const presence = context.module.exports;
    presence.start({ discordClientIds: { roon: "123" } });
    return { presence, server, children, timers, ready: () => ready(), exitCode: () => exitCode };
}

test("a port conflict exits without creating a tunnel", () => {
    const app = setup();
    assert.equal(app.children.length, 0);
    app.server.emit("error", new Error("EADDRINUSE"));
    assert.equal(app.exitCode(), 1);
    assert.equal(app.children.length, 0);
});

test("shutdown terminates the tunnel and does not schedule a restart", () => {
    const app = setup();
    app.ready();
    assert.equal(app.children.length, 1);
    app.presence.stopTunnel();
    assert.equal(app.children[0].killed, true);
    assert.equal(app.timers.size, 0);
    assert.doesNotThrow(() => app.presence.stopTunnel());
});

test("shutdown cancels a pending tunnel retry", () => {
    const app = setup();
    app.ready();
    app.children[0].emit("exit", 1);
    assert.equal(app.timers.size, 1);
    app.presence.stopTunnel();
    assert.equal(app.timers.size, 0);
});

test("shutdown before listening prevents a delayed tunnel launch", () => {
    const app = setup();
    app.presence.stopTunnel();
    app.ready();
    assert.equal(app.children.length, 0);
});

test("an unexpected tunnel exit still restarts while the app is running", () => {
    const app = setup();
    app.ready();
    app.children[0].emit("exit", 1);
    [...app.timers][0]();
    assert.equal(app.children.length, 2);
});

for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143], ["exit", undefined]]) {
    test(`the entry point cleans up its tunnel on ${signal}`, () => {
        const runtime = new EventEmitter();
        let exitCode;
        let cleanups = 0;
        runtime.argv = ["node", "index.js"];
        runtime.exit = (code) => { exitCode = code; runtime.emit("exit", code); };
        const fakes = {
            fs: { readFileSync: () => JSON.stringify({ discordClientIds: { foobar2000: "123" } }) },
            "./presence": { start() {}, update() {}, stopTunnel() { cleanups++; } },
            "./sources/foobar2000": { start() {} },
        };
        const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
        vm.runInNewContext("(function () {\n" + source + "\n})();", {
            require: (name) => fakes[name] || require(name),
            __dirname: path.join(__dirname, ".."),
            process: runtime,
            console: { log() {}, error() {} },
        });
        runtime.emit(signal);
        assert.equal(cleanups, 1);
        assert.equal(exitCode, expectedCode);
    });
}
