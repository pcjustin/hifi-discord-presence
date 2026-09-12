"use strict";

// The Roon source against a stand-in SDK: the same zone messages Roon sends, driven
// through the same callbacks, with the fake clock and fake Discord the foobar2000 suite
// uses. Everything stays synchronous - tick() is the only way time passes.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("fs");
const os = require("os");
const path = require("path");

let now = 0;
Date.now = () => now;
let nextTimerId = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + (ms || 0), fn });
    return { id, unref: () => id };
};
globalThis.clearTimeout = (handle) => timers.delete(handle && handle.id !== undefined ? handle.id : handle);

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

const flush = () => new Promise((resolve) => setImmediate(resolve));

const captured = {
    roonOptions: null,
    discord: null,
    activities: [],
    clears: 0,
    imageRequests: [],
    status: [],
    discoveryStarted: false,
    connections: [],
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

const fakes = {
    "@xhayper/discord-rpc": { Client: FakeDiscordClient },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    "node-roon-api": class {
        constructor(options) {
            captured.roonOptions = options;
            captured.roon = this;
        }
        init_services() {}
        ws_connect(options) {
            assert.strictEqual(this, captured.roon);
            captured.connections.push(options);
            return options;
        }
        start_discovery() {
            captured.discoveryStarted = true;
        }
    },
    "node-roon-api-status": class {
        set_status(text) {
            captured.status.push(text);
        }
    },
    "node-roon-api-transport": { name: "RoonApiTransport" },
    "node-roon-api-image": { name: "RoonApiImage" },
    http: {
        createServer(handler) {
            captured.requestHandler = handler;
            return { listen(_port, _host, ready) { ready(); }, on() {} };
        },
    },
    child_process: {
        spawn() {
            return {
                kill() {},
                stdout: { on: (_e, fn) => (captured.tunnelOutput = fn) },
                stderr: { on() {} },
                on() {},
            };
        },
    },
};

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-discord-roon-"));
const root = path.join(__dirname, "..");
fs.mkdirSync(path.join(appDir, "sources"));
for (const f of ["index.js", "presence.js", "sources/roon.js"]) {
    fs.copyFileSync(path.join(root, f), path.join(appDir, f));
}
const CONFIG = { source: "roon", discordClientId: "1234567890" };
fs.writeFileSync(path.join(appDir, "config.json"), JSON.stringify(CONFIG));

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

// The core object Roon hands to core_paired, with the two services the source uses.
let zonesCallback = null;
const core = {
    display_name: "Test Core",
    services: {
        RoonApiTransport: {
            subscribe_zones: (cb) => {
                zonesCallback = cb;
            },
        },
        RoonApiImage: {
            get_image: (imageKey, options, cb) => {
                captured.imageRequests.push({ imageKey, cb, done: false });
            },
        },
    },
};

captured.discord.handlers.ready();
captured.tunnelOutput(Buffer.from("INF |  " + TUNNEL + "  |"));
captured.roonOptions.core_paired(core);
tick(1000);

function zone(title, artist, album, imageKey, extra) {
    return Object.assign(
        {
            zone_id: "zone-1",
            display_name: "Living Room",
            state: "playing",
            now_playing: {
                image_key: imageKey,
                seek_position: 0,
                length: 240,
                three_line: { line1: title, line2: artist, line3: album },
            },
        },
        extra
    );
}

function subscribed(...zones) {
    zonesCallback("Subscribed", { zones });
    tick(300);
}

function changed(msg) {
    zonesCallback("Changed", msg);
    tick(300);
}

function play(z) {
    changed({ zones_changed: [z] });
}

function pendingImage() {
    return captured.imageRequests.filter((r) => !r.done).pop();
}

async function deliverImage(body) {
    const req = pendingImage();
    assert.ok(req, "expected a pending cover image fetch");
    req.done = true;
    req.cb(null, "image/jpeg", Buffer.from(body));
    await flush();
    tick(300);
}

async function failImage() {
    const req = pendingImage();
    assert.ok(req, "expected a pending cover image fetch");
    req.done = true;
    req.cb("no such image");
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
    return serve(activity.largeImageKey.slice(TUNNEL.length));
}

function lastActivity() {
    return captured.activities[captured.activities.length - 1];
}

function reset() {
    captured.activities.length = 0;
    captured.clears = 0;
}

test("pairing registers a zone subscription and starts discovery", () => {
    assert.ok(captured.discoveryStarted, "never started Roon discovery");
    assert.ok(zonesCallback, "never subscribed to zones");
    assert.deepStrictEqual(captured.status, ["Waiting for Roon Core..."]);
});

test("Roon connects only to the local Core", () => {
    for (const host of ["192.168.0.2", "192.168.0.3", "10.0.0.2", "fe80::1234"]) {
        assert.strictEqual(captured.roon.ws_connect({ host, port: 9330 }), undefined);
    }
    assert.deepStrictEqual(captured.connections, []);
    const options = { host: "127.0.0.1", port: 9330, onclose() {} };
    assert.strictEqual(captured.roon.ws_connect(options), options);
    assert.deepStrictEqual(captured.connections, [options]);
});

test("the first zone list reaches Discord", async () => {
    reset();
    subscribed(zone("Track One", "Artist One", "Album One", "img-1"));
    await deliverImage("COVER-ONE");
    assert.strictEqual(lastActivity().details, "Track One");
    assert.strictEqual(lastActivity().state, "Album One");
    assert.strictEqual(lastActivity().largeImageText, "Album One");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-ONE");
});

test("a track change sends one activity, and it already carries the cover", async () => {
    reset();
    play(zone("Track Two", "Artist Two", "Album Two", "img-2"));
    assert.strictEqual(captured.activities.length, 0, "sent an art-less activity before the cover arrived");

    await deliverImage("COVER-TWO");
    assert.strictEqual(captured.activities.length, 1, "sent more than one activity for one track change");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-TWO");
});

test("cover art is served per image key, never whichever cover was fetched last", async () => {
    reset();
    play(zone("Track Three", "Artist Three", "Album Three", "img-3"));
    await deliverImage("COVER-THREE");
    const third = lastActivity();

    play(zone("Track Four", "Artist Four", "Album Four", "img-4"));
    await deliverImage("COVER-FOUR");

    assert.strictEqual(fetchArt(third).body.toString(), "COVER-THREE");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-FOUR");
    assert.strictEqual(serve("/?k=never-fetched").status, 404);
});

test("a failed cover fetch still updates the track, without art, and is not retried", async () => {
    reset();
    const before = captured.imageRequests.length;
    play(zone("Track Five", "Artist Five", "Album Five", "img-5"));
    await failImage();

    assert.strictEqual(lastActivity().details, "Track Five");
    assert.strictEqual(lastActivity().largeImageKey, undefined);

    play(zone("Track Five", "Artist Five", "Album Five", "img-5", {
        now_playing: {
            image_key: "img-5",
            seek_position: 100,
            length: 240,
            three_line: { line1: "Track Five", line2: "Artist Five", line3: "Album Five" },
        },
    }));
    assert.strictEqual(
        captured.imageRequests.length - before,
        1,
        "re-fetched an image Roon already said it does not have"
    );
});

test("a cover fetch that never answers times out and the track still reaches Discord", () => {
    reset();
    play(zone("Track Six", "Artist Six", "Album Six", "img-6"));
    assert.strictEqual(captured.activities.length, 0);
    const attempts = captured.imageRequests.length;

    tick(5000);
    tick(300);
    assert.strictEqual(lastActivity().details, "Track Six");
    assert.strictEqual(lastActivity().largeImageKey, undefined);
    assert.strictEqual(captured.imageRequests.length, attempts, "restarted a timed-out fetch instead of giving up");
});

test("a late cover from a skipped-past track does not disturb the current fetch", async () => {
    reset();
    play(zone("Track Seven", "Artist Seven", "Album Seven", "img-7"));
    const stale = pendingImage();

    // Skipped past before its cover ever answered; the next track's fetch is what now
    // holds the presence back.
    play(zone("Track Eight", "Artist Eight", "Album Eight", "img-8"));
    assert.strictEqual(captured.activities.length, 0);
    const inFlight = captured.imageRequests.length;

    // The abandoned fetch answers late. Clearing the shared timer and the in-flight key
    // here would look harmless - the next push re-arms both - but only by asking Roon
    // for an image it is already fetching.
    stale.done = true;
    stale.cb(null, "image/jpeg", Buffer.from("COVER-SEVEN-LATE"));
    await flush();
    tick(300);
    assert.strictEqual(captured.activities.length, 0, "a stale cover pushed a presence of its own");
    assert.strictEqual(
        captured.imageRequests.length,
        inFlight,
        "a stale answer restarted the fetch that was already in flight"
    );

    tick(5000);
    tick(300);
    assert.strictEqual(lastActivity().details, "Track Eight", "the current track's timeout was disarmed");
});

test("skipping back shows the previous track's own title and cover together", async () => {
    reset();
    const nine = zone("Track Nine", "Artist Nine", "Album Nine", "img-9");
    const ten = zone("Track Ten", "Artist Ten", "Album Ten", "img-10");

    play(nine);
    await deliverImage("COVER-NINE");
    play(ten);
    await deliverImage("COVER-TEN");

    play(nine);
    assert.strictEqual(lastActivity().details, "Track Nine");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-NINE");
});

test("seek ticks are not resent to Discord, but dragging the timeline is", async () => {
    reset();
    const z = zone("Track Eleven", "Artist Eleven", "Album Eleven", "img-11");
    play(z);
    await deliverImage("COVER-ELEVEN");
    assert.strictEqual(captured.activities.length, 1);

    // Roon sends a seek-only message about once a second during ordinary playback.
    for (const seek_position of [1, 2, 3]) {
        changed({ zones_seek_changed: [{ zone_id: z.zone_id, seek_position }] });
    }
    assert.strictEqual(captured.activities.length, 1, "spent Discord's rate budget on ordinary seek ticks");

    changed({ zones_seek_changed: [{ zone_id: z.zone_id, seek_position: 150 }] });
    assert.strictEqual(captured.activities.length, 2, "a dragged timeline never reached Discord");
    assert.strictEqual(lastActivity().details, "Track Eleven", "a seek-only message lost the track");
    assert.strictEqual(lastActivity().endTimestamp - lastActivity().startTimestamp, 240000);
});

test("pausing every zone clears the presence", async () => {
    reset();
    const z = zone("Track Twelve", "Artist Twelve", "Album Twelve", "img-12");
    play(z);
    await deliverImage("COVER-TWELVE");
    reset();

    play(Object.assign({}, z, { state: "paused" }));
    assert.strictEqual(captured.clears, 1);
    assert.strictEqual(captured.activities.length, 0);

    play(z);
    assert.strictEqual(lastActivity().details, "Track Twelve");
});

test("a removed zone stops being considered", async () => {
    reset();
    const z = zone("Track Thirteen", "Artist Thirteen", "Album Thirteen", "img-13");
    play(z);
    await deliverImage("COVER-THIRTEEN");
    reset();

    changed({ zones_removed: [z.zone_id] });
    assert.strictEqual(captured.clears, 1, "kept a removed zone's track on the profile");
});

test("titles Discord would reject are padded and truncated, not dropped", async () => {
    reset();
    play(zone("夢", "李", "", "img-14"));
    await failImage();
    assert.strictEqual(lastActivity().details, "夢 ");
    assert.strictEqual(lastActivity().state, undefined);
    assert.strictEqual(lastActivity().largeImageText, undefined);

    reset();
    play(zone("T".repeat(200), "A".repeat(200), "L".repeat(200), "img-15"));
    await failImage();
    assert.strictEqual(lastActivity().details.length, 128);
    assert.strictEqual(lastActivity().state.length, 128);
    assert.strictEqual(lastActivity().largeImageText.length, 128);
});

test("a gapless handoff does not blink the presence off and on", async () => {
    // Roon reports 'loading' between tracks. Treated on its own that is "nothing is
    // playing", so without the debounce collapsing the burst the profile would clear
    // and re-fill on every track change.
    reset();
    const z = zone("Track Seventeen", "Artist Seventeen", "Album Seventeen", "img-17");
    play(z);
    await deliverImage("COVER-SEVENTEEN");
    reset();

    const next = zone("Track Eighteen", "Artist Eighteen", "Album Eighteen", "img-18");
    zonesCallback("Changed", { zones_changed: [Object.assign({}, z, { state: "loading" })] });
    zonesCallback("Changed", { zones_changed: [next] });
    tick(300);
    await deliverImage("COVER-EIGHTEEN");

    assert.strictEqual(captured.clears, 0, "cleared the profile during a gapless handoff");
    assert.strictEqual(lastActivity().details, "Track Eighteen");
});

test("a zone carrying only the fields Roon guarantees still reaches Discord", async () => {
    // image_key, length, line2 and line3 are all optional in Roon's own Zone type, and
    // a stream or a sparsely tagged file arrives with none of them.
    reset();
    const before = captured.imageRequests.length;
    changed({
        zones_changed: [{
            zone_id: "zone-1",
            display_name: "Living Room",
            state: "playing",
            now_playing: { three_line: { line1: "Bare Track" } },
        }],
    });

    assert.ok(lastActivity(), "a track with no cover image never reached Discord");
    assert.strictEqual(lastActivity().details, "Bare Track");
    assert.strictEqual(lastActivity().state, undefined);
    assert.strictEqual(lastActivity().largeImageText, undefined);
    assert.strictEqual(lastActivity().largeImageKey, undefined);
    assert.strictEqual(lastActivity().endTimestamp, undefined, "invented a progress bar with no track length");
    assert.strictEqual(captured.imageRequests.length, before, "asked Roon for an image the zone has no key for");
});

test("unpairing clears the presence", async () => {
    reset();
    play(zone("Track Sixteen", "Artist Sixteen", "Album Sixteen", "img-16"));
    await deliverImage("COVER-SIXTEEN");
    reset();

    captured.roonOptions.core_unpaired(core);
    tick(300);
    assert.strictEqual(captured.clears, 1, "left a stale track on the profile after unpairing");
});

test("Roon's pairing state is kept out of config.json", () => {
    // The SDK's default store is a relative "config.json" - ours. It rewrites it on
    // every pairing, so sharing the file puts discordClientId one bad write away from
    // being lost, and the next launch would exit at the config check.
    captured.roonOptions.set_persisted_state({ tokens: { core: "abc" } });

    assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(path.join(appDir, "config.json"), "utf8")),
        CONFIG,
        "the Roon SDK overwrote our own config file"
    );
    assert.ok(fs.existsSync(path.join(appDir, "roonstate.json")), "pairing state was not written beside index.js");
    assert.deepStrictEqual(captured.roonOptions.get_persisted_state(), { tokens: { core: "abc" } });
});

test("a first run with no state file reads as an empty pairing, not a crash", () => {
    fs.rmSync(path.join(appDir, "roonstate.json"));
    assert.deepStrictEqual(captured.roonOptions.get_persisted_state(), {});
});
