"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup(clientIds = { foobar2000: "foo", roon: "roon", upnp: "upnp" }) {
    let now = 1_000_000;
    let timerId = 0;
    const timers = new Map();
    const clients = [];
    const activities = [];
    class Client {
        constructor({ clientId }) {
            this.clientId = clientId;
            this.handlers = {};
            this.user = {
                setActivity: async (activity) => activities.push({ clientId, activity }),
                clearActivity: async () => {},
            };
            clients.push(this);
        }
        on(event, fn) { this.handlers[event] = fn; }
        async login() {}
        async destroy() { this.destroyed = true; }
    }
    const fakes = {
        "@xhayper/discord-rpc": { Client },
        "discord-api-types/v10": { ActivityType: { Listening: 2 } },
        http: { createServer: () => ({ listen() {}, on() {} }) },
        child_process: { spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {} }) },
    };
    const context = {
        require: (name) => fakes[name] || require(name),
        module: { exports: {} },
        __dirname: path.join(__dirname, ".."),
        process, URL, console: { log() {}, error() {} },
        Date: { now: () => now },
        setTimeout: (fn, ms) => {
            timers.set(++timerId, { at: now + ms, fn });
            return timerId;
        },
        clearTimeout: (id) => timers.delete(id),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "presence.js"), "utf8"), context);
    const presence = context.module.exports;
    presence.start({ discordClientIds: clientIds });
    function tick(ms) {
        const target = now + ms;
        for (;;) {
            const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].fn();
        }
        now = target;
    }
    return { presence, clients, activities, tick };
}

const track = (title, position = 0) => ({
    id: "http://station/live", title, artist: "Artist", album: "Album", position, duration: 240, artKey: null,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("rapid switches wait for the previous client's clear and destruction", async () => {
    const { presence, clients, activities, tick } = setup();
    presence.update("foobar2000", track("First"));
    clients[0].handlers.ready();
    tick(300);
    let cleared, destroyed;
    clients[0].user.clearActivity = () => new Promise((resolve) => (cleared = resolve));
    clients[0].destroy = () => new Promise((resolve) => (destroyed = resolve));
    presence.update("roon", track("Skipped"));
    presence.update("upnp", track("Latest"));
    await flush();
    assert.equal(clients.length, 1);
    cleared();
    await flush();
    assert.equal(clients.length, 1);
    destroyed();
    await flush();
    assert.equal(clients.length, 2);
    assert.equal(clients[1].clientId, "upnp");
    clients[1].handlers.ready();
    tick(300);
    assert.equal(activities.at(-1).activity.details, "Latest");
});

test("sources sharing an application can switch before READY and reconnect after switching", async () => {
    const { presence, clients, activities, tick } = setup({ foobar2000: "shared", roon: "shared" });
    presence.update("foobar2000", track("First"));
    presence.update("roon", track("Second"));
    assert.equal(clients.length, 1);
    clients[0].handlers.ready();
    tick(300);
    assert.equal(activities.at(-1)?.activity.details, "Second");
    clients[0].handlers.disconnected();
    tick(15000);
    await flush();
    assert.equal(clients.length, 2);
    clients[1].handlers.ready();
    tick(300);
    assert.equal(activities.at(-1).activity.details, "Second");
});

test("metadata changes on a continuous stream update once without resending progress", () => {
    const { presence, clients, activities, tick } = setup();
    presence.update("upnp", track("Song A"));
    clients[0].handlers.ready();
    tick(300);
    for (let position = 1; position <= 20; position++) {
        tick(position === 1 ? 700 : 1000);
        presence.update("upnp", track("Song A", position));
    }
    assert.equal(activities.length, 1);
    presence.update("upnp", track("Song B", 20));
    tick(300);
    assert.equal(activities.length, 2);
    assert.equal(activities.at(-1).activity.details, "Song B");
    presence.update("upnp", { ...track("Song B", 20), artist: "New artist", duration: 300 });
    tick(300);
    assert.equal(activities.at(-1).activity.state, "Album");
    assert.equal(activities.at(-1).activity.endTimestamp - activities.at(-1).activity.startTimestamp, 300000);
    presence.update("upnp", { ...track("Song B", 100), artist: "New artist", duration: 300 });
    tick(300);
    assert.equal(activities.length, 4);
});

test("a ready shared client reconnects after another source takes over", async () => {
    const { presence, clients, activities, tick } = setup({ foobar2000: "shared", roon: "shared" });
    presence.update("foobar2000", track("First"));
    clients[0].handlers.ready();
    tick(300);
    presence.update("roon", track("Second"));
    tick(300);
    clients[0].handlers.disconnected();
    tick(15000);
    await flush();
    assert.equal(clients.length, 2);
    clients[1].handlers.ready();
    tick(300);
    assert.equal(activities.at(-1).activity.details, "Second");
});

test("failed old-client cleanup does not strand the latest source", async () => {
    const { presence, clients, activities, tick } = setup();
    presence.update("foobar2000", track("First"));
    clients[0].handlers.ready();
    clients[0].user.clearActivity = async () => { throw new Error("Disconnected"); };
    clients[0].destroy = async () => { throw new Error("Already closed"); };
    presence.update("roon", track("Skipped"));
    presence.update("upnp", track("Latest"));
    await flush();
    assert.equal(clients.length, 2);
    clients[1].handlers.ready();
    tick(300);
    assert.equal(activities.at(-1).activity.details, "Latest");
});

test("artwork and album updates are published even without a seek or title change", async () => {
    const { presence, clients, activities, tick } = setup();
    presence.update("upnp", track("Song"));
    clients[0].handlers.ready();
    tick(300);
    let fetched = 0;
    const next = { ...track("Song"), album: "New album", artKey: "new-cover", getArt: async () => { fetched++; return null; } };
    presence.update("upnp", next);
    tick(300);
    await flush();
    tick(300);
    assert.equal(fetched, 1);
    assert.equal(activities.length, 2);
    assert.equal(activities.at(-1).activity.largeImageText, "New album");
    presence.update("upnp", { ...next, artKey: "another-cover" });
    tick(300);
    await flush();
    tick(300);
    assert.equal(fetched, 2);
    assert.equal(activities.length, 3);
});

test("list status follows title changes and falls back when metadata is missing", () => {
    const { presence, clients, activities, tick } = setup();
    presence.update("roon", track("Song"));
    clients[0].handlers.ready();
    tick(300);
    assert.equal(activities.at(-1).activity.statusDisplayType, 2);
    presence.update("roon", track("Next Song"));
    tick(300);
    assert.equal(activities.at(-1).activity.details, "Next Song");
    assert.equal(activities.at(-1).activity.statusDisplayType, 2);
    presence.update("roon", track(""));
    tick(300);
    assert.equal(activities.at(-1).activity.statusDisplayType, 1);
    assert.equal(activities.at(-1).activity.state, "Album");
    presence.update("roon", { ...track(""), album: "" });
    tick(300);
    assert.equal(activities.at(-1).activity.statusDisplayType, 0);
});

test("losing UPnP falls back to another playing source", async () => {
    const { presence, clients, activities, tick } = setup();
    presence.update("roon", track("Roon"));
    clients[0].handlers.ready();
    tick(300);
    presence.update("upnp", track("Renderer"));
    await flush();
    clients.at(-1).handlers.ready();
    tick(300);
    presence.update("upnp", null);
    await flush();
    clients.at(-1).handlers.ready();
    tick(300);
    assert.equal(activities.at(-1).clientId, "roon");
    assert.equal(activities.at(-1).activity.details, "Roon");
});
