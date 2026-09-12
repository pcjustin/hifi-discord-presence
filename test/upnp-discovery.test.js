"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function setup(failure) {
    let poll;
    const sockets = [];
    const timers = new Set();
    const pushed = [];
    const fake = { dgram: { createSocket() {
        const socket = new EventEmitter();
        socket.bind = (ready) => {
            if (sockets.length === 1 && failure === "bind") socket.emit("error", new Error("EACCES"));
            else if (sockets.length !== 1 || failure !== "silent") ready();
        };
        socket.send = () => {
            if (sockets.length === 1 && failure === "send") throw new Error("ENETUNREACH");
        };
        socket.close = () => { socket.closed = true; };
        sockets.push(socket);
        return socket;
    } } };
    const context = {
        module: { exports: {} }, require: (name) => fake[name] || require(name),
        console: { log() {}, error() {} }, Buffer, URL, AbortSignal,
        setTimeout: (callback) => { timers.add(callback); return callback; },
        clearTimeout: (callback) => timers.delete(callback),
        setInterval: (callback) => { poll = callback; },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "sources/upnp.js"), "utf8"), context);
    context.module.exports.start({}, (track) => pushed.push(track));
    return { sockets, timers, pushed, poll: () => poll(), expire: () => { for (const callback of [...timers]) callback(); } };
}

for (const failure of ["bind", "send", "silent"]) {
    test(`discovery recovers after a ${failure} failure`, async () => {
        const app = setup(failure);
        if (failure === "silent") app.expire();
        await new Promise(setImmediate);
        assert.equal(app.sockets[0].closed, true);
        assert.equal(app.pushed.length, 1);
        const next = app.poll();
        assert.equal(app.sockets.length, 2);
        app.expire();
        await next;
        assert.equal(app.pushed.length, 2);
        assert.equal(app.timers.size, 0);
    });
}
