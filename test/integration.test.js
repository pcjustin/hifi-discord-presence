"use strict";

// index.js is a daemon with no exports: it connects to Discord, spawns cloudflared,
// opens a port and subscribes to a source the moment it is required. So it is loaded
// once here against fake modules and a fake clock, and driven through the same callbacks
// beefweb and Discord would make. Everything stays synchronous - tick() is the only way
// time passes. The foobar2000 source is the driver; everything downstream of push() is
// the shared core all three sources use.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("fs");
const os = require("os");
const path = require("path");

let now = 0;
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
        for (const [id, t] of timers) {
            if (t.at <= target && (!due || t.at < due.timer.at)) due = { id, timer: t };
        }
        if (!due) break;
        now = due.timer.at;
        timers.delete(due.id);
        due.timer.fn();
    }
    now = target;
}

const captured = {
    requestHandler: null,
    discord: null,
    activities: [],
    clears: 0,
    subscriptions: [],
    artRequests: [],
    tunnelOutput: null,
    stream: null,
};

class FakeDiscordClient {
    constructor() {
        this.handlers = {};
        this.user = {
            setActivity: (activity) => {
                captured.activities.push(activity);
                return Promise.resolve();
            },
            clearActivity: () => {
                captured.clears += 1;
                return Promise.resolve();
            },
        };
        captured.discord = this;
    }
    on(event, fn) {
        this.handlers[event] = fn;
    }
    login() {
        return Promise.resolve();
    }
}

// A stand-in for an http.IncomingMessage: listeners are stored so the test can push
// data, end and error at exactly the moment a scenario needs them.
function fakeResponse(statusCode, headers) {
    const listeners = {};
    return {
        statusCode,
        headers: headers || {},
        setEncoding() {},
        resume() {},
        on(event, fn) {
            listeners[event] = fn;
            return this;
        },
        fire(event, arg) {
            if (listeners[event]) listeners[event](arg);
        },
    };
}

const fakes = {
    "@xhayper/discord-rpc": { Client: FakeDiscordClient },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    http: {
        createServer(handler) {
            captured.requestHandler = handler;
            return { listen() {}, on() {} };
        },
        get(url, options, callback) {
            const cb = typeof options === "function" ? options : callback;
            const request = { on: () => request };
            const target = url.includes("/api/query/updates") ? captured.subscriptions : captured.artRequests;
            target.push({ url, cb, done: false });
            return request;
        },
    },
    child_process: {
        spawn() {
            return {
                stdout: { on: (_e, fn) => (captured.tunnelOutput = fn) },
                stderr: { on() {} },
                on() {},
            };
        },
    },
};

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-discord-test-"));
const root = path.join(__dirname, "..");
fs.mkdirSync(path.join(appDir, "sources"));
for (const f of ["index.js", "presence.js", "sources/foobar2000.js"]) {
    fs.copyFileSync(path.join(root, f), path.join(appDir, f));
}
fs.writeFileSync(
    path.join(appDir, "config.json"),
    JSON.stringify({ source: "foobar2000", discordClientId: "1234567890" })
);

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.call(this, request, ...rest);
};
console.log = () => {};
console.error = () => {};
require(path.join(appDir, "index.js"));
Module._load = origLoad;

const TUNNEL = "https://test-tunnel.trycloudflare.com";

function openStream() {
    const pending = captured.subscriptions[captured.subscriptions.length - 1];
    assert.ok(pending && !pending.done, "no beefweb subscription is waiting to be answered");
    pending.done = true;
    const res = fakeResponse(200, { "content-type": "text/event-stream" });
    captured.stream = res;
    pending.cb(res);
    return res;
}

captured.discord.handlers.ready();
captured.tunnelOutput(Buffer.from("INF |  " + TUNNEL + "  |"));
openStream();
tick(1000);

function track(title, artist, album, filePath, extra) {
    return Object.assign(
        {
            playlistId: "p1",
            index: 0,
            position: 0,
            duration: 240,
            columns: [artist, title, album, filePath],
        },
        extra
    );
}

function send(playerUpdate) {
    captured.stream.fire("data", "data: " + JSON.stringify({ player: playerUpdate }) + "\n\n");
    tick(300);
}

function play(item) {
    send({ playbackState: "playing", activeItem: item });
}

// Scans from the newest: a fetch that timed out in an earlier test is still sitting
// there unanswered, and answering that one instead would test nothing.
function pendingArt() {
    return captured.artRequests.filter((r) => !r.done).pop();
}

function artCount() {
    return captured.artRequests.length;
}

// The core resolves the art through a promise, so a microtask has to run before the
// presence it schedules exists. setImmediate is untouched by the fake clock.
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function deliverArt(body) {
    const req = pendingArt();
    assert.ok(req, "expected a pending cover art fetch");
    req.done = true;
    const res = fakeResponse(200, { "content-type": "image/jpeg" });
    req.cb(res);
    res.fire("data", Buffer.from(body));
    res.fire("end");
    await flush();
    tick(300);
}

async function missingArt() {
    const req = pendingArt();
    assert.ok(req, "expected a pending cover art fetch");
    req.done = true;
    req.cb(fakeResponse(404, {}));
    await flush();
    tick(300);
}

function serve(url) {
    const res = { status: 0, headers: null, body: null };
    captured.requestHandler(
        { url },
        {
            writeHead: (status, headers) => {
                res.status = status;
                res.headers = headers;
            },
            end: (body) => (res.body = body),
        }
    );
    return res;
}

function fetchArt(activity) {
    assert.ok(activity.largeImageKey, "activity carries no cover art URL");
    assert.ok(activity.largeImageKey.startsWith(TUNNEL), "cover art URL is not the tunnel URL");
    return serve(activity.largeImageKey.slice(TUNNEL.length));
}

function lastActivity() {
    return captured.activities[captured.activities.length - 1];
}

function reset() {
    captured.activities.length = 0;
    captured.clears = 0;
}

// Every test uses its own file paths: the app caches covers by track identity for the
// process's lifetime, and it is loaded once for the whole file.

test("cover art is served per track, never whichever cover was fetched last", async () => {
    reset();
    play(track("Track One", "Artist One", "Album One", "C:\\music\\1.flac"));
    await deliverArt("COVER-ONE");
    const first = lastActivity();

    play(track("Track Two", "Artist Two", "Album Two", "C:\\music\\2.flac"));
    await deliverArt("COVER-TWO");
    const second = lastActivity();

    assert.strictEqual(fetchArt(first).body.toString(), "COVER-ONE");
    assert.strictEqual(fetchArt(second).body.toString(), "COVER-TWO");
    assert.strictEqual(serve("/?k=never-fetched").status, 404);
    assert.strictEqual(serve("/").status, 404);
});

test("a track change sends one activity, and it already carries the cover", async () => {
    reset();
    play(track("Track Three", "Artist Three", "Album Three", "C:\\music\\3.flac"));
    assert.strictEqual(captured.activities.length, 0, "sent an art-less activity before the cover arrived");

    await deliverArt("COVER-THREE");
    assert.strictEqual(captured.activities.length, 1, "sent more than one activity for one track change");
    assert.strictEqual(lastActivity().details, "Track Three");
    assert.strictEqual(lastActivity().state, "Artist Three");
    assert.strictEqual(lastActivity().largeImageText, "Album Three");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-THREE");
});

test("a track with no cover art still reaches Discord, and is not re-fetched", async () => {
    reset();
    const before = artCount();
    play(track("Track Four", "Artist Four", "Album Four", "C:\\music\\4.flac"));
    await missingArt();

    assert.strictEqual(lastActivity().details, "Track Four");
    assert.strictEqual(lastActivity().largeImageKey, undefined);

    play(track("Track Four", "Artist Four", "Album Four", "C:\\music\\4.flac", { position: 0 }));
    assert.strictEqual(artCount() - before, 1, "re-fetched a cover beefweb already said it does not have");
});

test("a cover fetch that never answers times out and the track still reaches Discord", async () => {
    reset();
    play(track("Track Five", "Artist Five", "Album Five", "C:\\music\\5.flac"));
    assert.strictEqual(captured.activities.length, 0);
    const attempts = artCount();

    tick(5000);
    tick(300);
    assert.strictEqual(lastActivity().details, "Track Five");
    assert.strictEqual(lastActivity().largeImageKey, undefined);
    assert.strictEqual(artCount(), attempts, "restarted a timed-out fetch instead of giving up");
});

test("skipping back shows the previous track's own title and cover together", async () => {
    reset();
    const trackA = track("Track Six", "Artist Six", "Album Six", "C:\\music\\6.flac");
    const trackB = track("Track Seven", "Artist Seven", "Album Seven", "C:\\music\\7.flac");

    play(trackA);
    await deliverArt("COVER-SIX");
    play(trackB);
    await deliverArt("COVER-SEVEN");

    play(trackA);
    assert.strictEqual(lastActivity().details, "Track Six");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-SIX");
});

test("two files sharing artist/title/album keep their own covers", async () => {
    reset();
    play(track("Same Title", "Same Artist", "Same Album", "C:\\music\\take-1.flac"));
    await deliverArt("COVER-TAKE-ONE");
    const takeOne = lastActivity();

    play(track("Same Title", "Same Artist", "Same Album", "C:\\music\\take-2.flac"));
    await deliverArt("COVER-TAKE-TWO");

    assert.strictEqual(fetchArt(takeOne).body.toString(), "COVER-TAKE-ONE");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-TAKE-TWO");
});

test("position ticks are not resent to Discord, but a manual seek is", async () => {
    reset();
    play(track("Track Eight", "Artist Eight", "Album Eight", "C:\\music\\8.flac"));
    await deliverArt("COVER-EIGHT");
    assert.strictEqual(captured.activities.length, 1);

    // beefweb sends only what changed, so a position tick carries an activeItem with
    // nothing but a position in it.
    send({ activeItem: { position: 1 } });
    send({ activeItem: { position: 2 } });
    send({ activeItem: { position: 3 } });
    assert.strictEqual(captured.activities.length, 1, "spent Discord's rate budget on ordinary position ticks");

    send({ activeItem: { position: 150 } });
    assert.strictEqual(captured.activities.length, 2, "a dragged seekbar never reached Discord");
    assert.strictEqual(lastActivity().details, "Track Eight", "a position-only update lost the track's columns");
    assert.strictEqual(
        lastActivity().endTimestamp - lastActivity().startTimestamp,
        240000,
        "track length was lost by the merge"
    );
});

test("pausing clears the presence, resuming restores it", async () => {
    reset();
    const item = track("Track Nine", "Artist Nine", "Album Nine", "C:\\music\\9.flac");
    play(item);
    await deliverArt("COVER-NINE");
    reset();

    send({ playbackState: "paused" });
    assert.strictEqual(captured.clears, 1);
    assert.strictEqual(captured.activities.length, 0);

    send({ playbackState: "playing" });
    assert.strictEqual(lastActivity().details, "Track Nine");
});

test("internet radio gets an elapsed counter, not a progress bar to nowhere", async () => {
    reset();
    play(track("Some Stream", "Some Station", "", "http://radio.example/stream", { duration: -1 }));
    await missingArt();
    assert.strictEqual(lastActivity().details, "Some Stream");
    assert.strictEqual(lastActivity().endTimestamp, undefined);
});

test("titles Discord would reject are padded and truncated, not dropped", async () => {
    reset();
    play(track("夢", "李", "", "C:\\music\\short.flac"));
    await missingArt();
    assert.strictEqual(lastActivity().details, "夢 ");
    assert.strictEqual(lastActivity().state, "李 ");
    assert.strictEqual(lastActivity().largeImageText, undefined);

    reset();
    play(track("T".repeat(200), "A".repeat(200), "L".repeat(200), "C:\\music\\long.flac"));
    await missingArt();
    assert.strictEqual(lastActivity().details.length, 128);
    assert.strictEqual(lastActivity().state.length, 128);
    assert.strictEqual(lastActivity().largeImageText.length, 128);
});

test("foobar2000 closing clears the presence, and the subscription is retried", async () => {
    reset();
    play(track("Track Ten", "Artist Ten", "Album Ten", "C:\\music\\10.flac"));
    await deliverArt("COVER-TEN");
    reset();

    const before = captured.subscriptions.length;
    captured.stream.fire("end");
    tick(300);
    assert.strictEqual(captured.clears, 1, "left a stale track on the Discord profile");
    assert.strictEqual(captured.subscriptions.length, before, "reconnected without waiting");

    tick(15000);
    assert.strictEqual(captured.subscriptions.length, before + 1, "never reconnected to beefweb");

    openStream();
    play(track("Track Ten", "Artist Ten", "Album Ten", "C:\\music\\10.flac"));
    assert.strictEqual(lastActivity().details, "Track Ten");
});
