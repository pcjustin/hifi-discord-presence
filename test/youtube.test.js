"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

test("YouTube expires missing heartbeats and accepts playback again", () => {
    let handler;
    let timer;
    const updates = [];
    const context = {
        module: { exports: {} }, console,
        require: () => ({ createServer: (fn) => {
            handler = fn;
            return { on() {}, listen() {} };
        } }),
        setTimeout: (fn, delay) => { timer = { fn, delay }; return timer; },
        clearTimeout: () => { timer = null; },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve("../sources/youtube"), "utf8"), context);
    context.module.exports.start({}, (state) => updates.push(state));
    function request(method, body) {
        const req = new EventEmitter();
        Object.assign(req, { method, url: "/state" });
        let result;
        handler(req, { setHeader() {}, writeHead() {}, end(value) { result = value; } });
        if (method === "POST") {
            req.emit("data", JSON.stringify(body));
            req.emit("end");
        }
        return result;
    }
    const track = { title: "Song", playing: true };
    request("POST", track);
    const first = timer;
    request("POST", track);
    assert.notEqual(timer, first);
    assert.equal(timer.delay, 15000);
    timer.fn();
    assert.equal(updates.at(-1), null);
    assert.equal(request("GET"), "null");
    request("POST", track);
    assert.equal(updates.at(-1).title, "Song");
    request("POST", null);
    assert.equal(updates.at(-1), null);
    assert.equal(timer, null);
});

test("extension sends heartbeats even at unchanged position and stops on pagehide", () => {
    const requests = [];
    let poll;
    let pagehide;
    vm.runInNewContext(fs.readFileSync(require.resolve("../youtube-extension/content"), "utf8"), {
        document: { querySelector: (selector) => selector === "video"
            ? { duration: 100, currentTime: 10, paused: false, ended: false }
            : { textContent: "Song" } },
        location: { href: "https://www.youtube.com/watch?v=abc", search: "?v=abc" },
        URLSearchParams,
        fetch: (url, options) => { requests.push(options); return Promise.resolve(); },
        setInterval: (fn) => { poll = fn; },
        window: { addEventListener: (event, fn) => {
            assert.equal(event, "pagehide");
            pagehide = fn;
        } },
    });
    poll();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    pagehide();
    assert.equal(requests.at(-1).body, "null");
    assert.equal(requests.at(-1).keepalive, true);
});
