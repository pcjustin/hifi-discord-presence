"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { launch, supervise } = require("../start-windows");

function directory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-launch-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("background launch disconnects from the calling console and keeps logs", async (t) => {
    const dir = directory(t);
    let detached = false;
    await launch(dir, (file, args, options) => {
        assert.equal(file, process.execPath);
        assert.deepEqual(args, [path.join(dir, "start-windows.js"), "--supervise"]);
        assert.equal(options.detached, true);
        assert.equal(options.windowsHide, true);
        assert.equal(options.stdio[0], "ignore");
        assert.ok(options.stdio[1] > 2);
        assert.equal(options.stdio[1], options.stdio[2]);
        fs.writeSync(options.stdio[1], "background log\n");
        const child = new EventEmitter();
        child.unref = () => { detached = true; };
        process.nextTick(() => child.emit("spawn"));
        return child;
    });
    assert.equal(detached, true);
    assert.equal(fs.readFileSync(path.join(dir, "hifi-discord.log"), "utf8"), "background log\n");
});

test("background launch reports a failed spawn", async (t) => {
    await assert.rejects(launch(directory(t), () => {
        const child = new EventEmitter();
        process.nextTick(() => child.emit("error", new Error("Access denied")));
        return child;
    }), /Access denied/);
});

test("supervisor restarts after a failed spawn only once and without a console", () => {
    const children = [];
    const timers = [];
    supervise("C:\\HiFi", (file, args, options) => {
        assert.equal(file, process.execPath);
        assert.equal(options.windowsHide, true);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        children.push(child);
        return child;
    }, (callback, delay) => timers.push({ callback, delay }));
    children[0].emit("error", new Error("spawn failed"));
    children[0].emit("close", -1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 15000);
    timers[0].callback();
    assert.equal(children.length, 2);
    for (const child of children) {
        child.stdout.unpipe();
        child.stderr.unpipe();
    }
});
