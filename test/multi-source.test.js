"use strict";

// Drives the shared presence core with three sources and three Discord applications.
// The network-facing source modules have their own end-to-end tests; this file covers
// arbitration between them and the RPC client handoff that only multi-source mode uses.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

let now = 0;
Date.now = () => now;
let nextTimerId = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);

function tick(ms) {
    const target = now + ms;
    for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
            if (timer.at <= target && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;
        now = due.timer.at;
        timers.delete(due.id);
        due.timer.fn();
    }
    now = target;
}

const captured = { clients: [], activities: [], clears: [], destroys: [] };

class FakeDiscordClient {
    constructor(options) {
        this.clientId = options.clientId;
        this.handlers = {};
        this.user = {
            setActivity: (activity) => {
                captured.activities.push({ clientId: this.clientId, activity });
                return Promise.resolve();
            },
            clearActivity: () => {
                captured.clears.push(this.clientId);
                return Promise.resolve();
            },
        };
        captured.clients.push(this);
    }
    on(event, fn) {
        this.handlers[event] = fn;
    }
    login() {
        return Promise.resolve();
    }
    destroy() {
        captured.destroys.push(this.clientId);
        return Promise.resolve();
    }
}

const fakes = {
    "@xhayper/discord-rpc": { Client: FakeDiscordClient },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    http: { createServer: () => ({ listen() {}, on() {} }) },
    child_process: {
        spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {} }),
    },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.call(this, request, ...rest);
};
const presence = require("../presence.js");

presence.start({
    discordClientIds: { foobar2000: "FOO-ID", roon: "ROON-ID", upnp: "UPNP-ID" },
});

function track(id, title, position = 0) {
    return { id, title, artist: "Artist", album: "Album", duration: 240, position, artKey: null };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function finishHandoff(expectedId) {
    // Clearing and destroying the previous RPC client are promise-based; let that chain
    // finish before announcing READY on the newly constructed client.
    await flush();
    await flush();
    const client = captured.clients[captured.clients.length - 1];
    assert.strictEqual(client.clientId, expectedId);
    client.handlers.ready();
    tick(300);
    return client;
}

test("a newly playing source selects its own Discord application", async () => {
    presence.update("foobar2000", track("foo-1", "Foobar Track"));
    await finishHandoff("FOO-ID");
    assert.strictEqual(captured.activities.at(-1).clientId, "FOO-ID");
    assert.strictEqual(captured.activities.at(-1).activity.details, "Foobar Track");

    presence.update("roon", track("roon-1", "Roon Track"));
    await finishHandoff("ROON-ID");
    assert.strictEqual(captured.activities.at(-1).clientId, "ROON-ID");
    assert.strictEqual(captured.activities.at(-1).activity.details, "Roon Track");
    assert.ok(captured.clears.includes("FOO-ID"));
    assert.ok(captured.destroys.includes("FOO-ID"));
});

test("routine ticks from an inactive source do not steal the presence", () => {
    const clientsBefore = captured.clients.length;
    const activitiesBefore = captured.activities.length;
    presence.update("foobar2000", track("foo-1", "Foobar Track", 1));
    tick(300);
    assert.strictEqual(captured.clients.length, clientsBefore);
    assert.strictEqual(captured.activities.length, activitiesBefore);
});

test("stopping the active source falls back to the still-playing source", async () => {
    presence.update("roon", null);
    await finishHandoff("FOO-ID");
    assert.strictEqual(captured.activities.at(-1).clientId, "FOO-ID");
    assert.strictEqual(captured.activities.at(-1).activity.details, "Foobar Track");
});

test("an inactive source stopping does not clear the selected source", async () => {
    presence.update("upnp", track("upnp-1", "UPnP Track"));
    await finishHandoff("UPNP-ID");
    const clearsBefore = captured.clears.length;
    const activitiesBefore = captured.activities.length;

    presence.update("foobar2000", null);
    tick(300);
    assert.strictEqual(captured.clears.length, clearsBefore);
    assert.strictEqual(captured.activities.length, activitiesBefore);
    assert.strictEqual(captured.activities.at(-1).activity.details, "UPnP Track");
});

test("the last source stopping clears Discord and can resume on the same client", () => {
    const clientCount = captured.clients.length;
    const clearsBefore = captured.clears.length;
    presence.update("upnp", null);
    tick(300);
    assert.strictEqual(captured.clears.length, clearsBefore + 1);

    presence.update("upnp", track("upnp-1", "UPnP Track", 12));
    tick(300);
    assert.strictEqual(captured.clients.length, clientCount);
    assert.strictEqual(captured.activities.at(-1).clientId, "UPNP-ID");
    assert.strictEqual(captured.activities.at(-1).activity.details, "UPnP Track");
});
