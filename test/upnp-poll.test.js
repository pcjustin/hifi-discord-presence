"use strict";

// The UPnP source driven end to end against a fake network: SSDP answers, device
// descriptions and SOAP responses all come from here, so a poll walks the same path it
// walks against a real streamer. test/upnp.test.js covers the parsers underneath.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("fs");
const os = require("os");
const path = require("path");

let now = 0;
let nextTimerId = 1;
const timers = new Map();
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + (ms || 0), fn });
    return { id, unref: () => id };
};
globalThis.clearTimeout = (handle) => timers.delete(handle && handle.id !== undefined ? handle.id : handle);
// The poll interval is captured rather than run: a test decides when the next poll
// happens, so nothing fires between the assertions.
globalThis.setInterval = (fn) => {
    captured.pollFn = fn;
    return { unref: () => {} };
};

const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

// Advances to the earliest pending timer only, letting promises settle in between, so
// the async poll chain unwinds without the clock overshooting into the next step.
async function settle(steps = 60) {
    for (let i = 0; i < steps; i++) {
        await flush();
        // No break on an empty timer list: a fetch still in flight can arm the next
        // timer several microtasks from now, and stopping here would strand the chain.
        if (!timers.size) continue;
        let due = null;
        for (const [id, t] of timers) if (!due || t.at < due.timer.at) due = { id, timer: t };
        now = Math.max(now, due.timer.at);
        timers.delete(due.id);
        due.timer.fn();
    }
    await flush();
}

const RENDERER_LOCATION = "http://10.0.0.20:49152/description.xml";
const CONTROL = "http://10.0.0.20:49152/upnp/control/rendertransport1";
const SERVER_LOCATION = "http://10.0.0.30:9790/description.xml";

const captured = {
    activities: [],
    clears: 0,
    discord: null,
    pollFn: null,
    ssdpSearches: [],
    fetches: [],
    requestHandler: null,
    tunnelOutput: null,
};

// What the fake network answers with. A test rewrites these before driving a poll.
const network = {
    ssdp: { "urn:schemas-upnp-org:device:MediaRenderer:1": [RENDERER_LOCATION] },
    transportState: "PLAYING",
    positionInfo: null,
    art: {}, // url -> body, or missing for a 404
    searchResult: null,
};

function description(friendlyName, serviceType, controlPath) {
    return `<?xml version="1.0"?><root><device><friendlyName>${friendlyName}</friendlyName>
<serviceList><service><serviceType>${serviceType}</serviceType>
<controlURL>${controlPath}</controlURL></service></serviceList></device></root>`;
}

function positionInfo(title, artist, album, artUri, trackUri, duration, relTime) {
    const didl = `<DIDL-Lite><item>
<dc:title>${title}</dc:title><upnp:artist>${artist}</upnp:artist><upnp:album>${album}</upnp:album>
${artUri ? `<upnp:albumArtURI>${artUri}</upnp:albumArtURI>` : ""}
</item></DIDL-Lite>`;
    const escaped = didl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<TrackDuration>${duration}</TrackDuration><TrackMetaData>${escaped}</TrackMetaData>
<TrackURI>${trackUri}</TrackURI><RelTime>${relTime}</RelTime>`;
}

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

globalThis.fetch = (url, options) => {
    captured.fetches.push(url);
    const body = (options && options.body) || "";
    const reply = (text) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });

    if (url === RENDERER_LOCATION) {
        return reply(description("Living Room Streamer", "urn:schemas-upnp-org:service:AVTransport:1",
            "/upnp/control/rendertransport1"));
    }
    if (url === SERVER_LOCATION) {
        return reply(description("MinimServer", "urn:schemas-upnp-org:service:ContentDirectory:1", "/ctl"));
    }
    if (body.includes("GetTransportInfo")) {
        return reply(`<CurrentTransportState>${network.transportState}</CurrentTransportState>`);
    }
    if (body.includes("GetPositionInfo")) {
        return reply(network.positionInfo);
    }
    if (body.includes("u:Search")) {
        return network.searchResult
            ? reply(network.searchResult)
            : Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("") });
    }
    // Anything else is a cover art GET.
    if (Object.prototype.hasOwnProperty.call(network.art, url)) {
        return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => "image/jpeg" },
            arrayBuffer: () => Promise.resolve(Buffer.from(network.art[url])),
        });
    }
    return Promise.resolve({ ok: false, status: 404, headers: { get: () => null } });
};

const fakes = {
    "@xhayper/discord-rpc": { Client: FakeDiscordClient },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    http: {
        createServer(handler) {
            captured.requestHandler = handler;
            return { listen() {}, on() {} };
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
    dgram: {
        createSocket() {
            const listeners = {};
            return {
                on(event, fn) {
                    listeners[event] = fn;
                },
                bind(cb) {
                    cb();
                },
                send(msg) {
                    const text = msg.toString();
                    // Anchored: "HOST: 239.255.255.250:1900" ends in "ST: " too, and an
                    // unanchored match reads the multicast address as the search target.
                    const st = /^ST: (\S+)/m.exec(text)[1];
                    captured.ssdpSearches.push(st);
                    for (const location of network.ssdp[st] || []) {
                        listeners.message(Buffer.from("HTTP/1.1 200 OK\r\nLOCATION: " + location + "\r\n\r\n"));
                    }
                },
                close() {},
            };
        },
    },
};

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-discord-upnp-"));
const root = path.join(__dirname, "..");
fs.mkdirSync(path.join(appDir, "sources"));
for (const f of ["index.js", "presence.js", "sources/upnp.js"]) {
    fs.copyFileSync(path.join(root, f), path.join(appDir, f));
}
fs.writeFileSync(
    path.join(appDir, "config.json"),
    JSON.stringify({ source: "upnp", discordClientId: "1234567890", rendererName: "Living Room" })
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

function reset() {
    captured.activities.length = 0;
    captured.clears = 0;
    captured.fetches.length = 0;
    captured.ssdpSearches.length = 0;
}

function lastActivity() {
    return captured.activities[captured.activities.length - 1];
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

// The first poll runs as the module loads, before Discord is ready; drain it so each
// test starts from a settled state.
// Started, not awaited: a poll that has to rediscover the renderer parks on the SSDP
// timer, and only settle() can move the clock that releases it.
async function poll() {
    captured.pollFn();
    await settle();
}

test("setup: discovery, Discord and the tunnel come up", async () => {
    // Nothing is playing yet: the poll that started as the module loaded is still
    // suspended on the SSDP timer, and letting it finish with a track would consume the
    // first activity the next test asserts on.
    await settle();
    captured.discord.handlers.ready();
    captured.tunnelOutput(Buffer.from("INF |  " + TUNNEL + "  |"));
    await settle();

    assert.ok(captured.ssdpSearches.includes("urn:schemas-upnp-org:device:MediaRenderer:1"),
        "never searched for a renderer");
});

test("a playing track reaches Discord with its cover", async () => {
    reset();
    network.positionInfo = positionInfo("Track One", "Artist One", "Album One",
        "http://10.0.0.30/Album/art.jpg", "http://10.0.0.30/Album/01.flac", "00:04:00", "00:00:00");
    network.art["http://10.0.0.30/Album/art.jpg"] = "COVER-ONE";
    await poll();

    // One call, already carrying the art. Discord rate-limits setActivity, so an
    // art-less update followed by the real one loses whichever arrives second.
    assert.strictEqual(captured.activities.length, 1, "sent an art-less activity before the cover arrived");
    assert.strictEqual(lastActivity().details, "Track One");
    assert.strictEqual(lastActivity().state, "Artist One");
    assert.strictEqual(lastActivity().largeImageText, "Album One");
    assert.strictEqual(lastActivity().endTimestamp - lastActivity().startTimestamp, 240000);
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-ONE");
});

test("the control URL is reused, not rediscovered on every poll", async () => {
    reset();
    await poll();
    assert.strictEqual(captured.ssdpSearches.length, 0, "ran SSDP discovery again with a working control URL");
    assert.ok(captured.fetches.some((u) => u === CONTROL), "stopped talking to the renderer");
});

test("ordinary progress is not resent, a seek is", async () => {
    reset();
    network.positionInfo = positionInfo("Track One", "Artist One", "Album One",
        "http://10.0.0.30/Album/art.jpg", "http://10.0.0.30/Album/01.flac", "00:04:00", "00:00:05");
    await poll();
    assert.strictEqual(captured.activities.length, 0, "spent Discord's rate budget on ordinary playback");

    network.positionInfo = positionInfo("Track One", "Artist One", "Album One",
        "http://10.0.0.30/Album/art.jpg", "http://10.0.0.30/Album/01.flac", "00:04:00", "00:02:30");
    await poll();
    assert.strictEqual(captured.activities.length, 1, "a dragged timeline never reached Discord");
});

test("a stopped renderer clears the presence", async () => {
    reset();
    network.transportState = "STOPPED";
    await poll();
    assert.strictEqual(captured.clears, 1);
    assert.strictEqual(captured.activities.length, 0);

    network.transportState = "PLAYING";
});

test("the folder image is used when the advertised art 404s", async () => {
    reset();
    network.positionInfo = positionInfo("Track Two", "Artist Two", "Album Two",
        "http://10.0.0.30/Album/01.flac/$!pict", "http://10.0.0.30/Album/02.flac", "00:03:00", "00:00:00");
    // MinimServer advertises the first track's embedded picture, which is not there.
    network.art["http://10.0.0.30/Album/cover.jpg"] = "COVER-FOLDER";
    await poll();

    assert.strictEqual(lastActivity().details, "Track Two");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-FOLDER");
});

test("a truncated art URL is recovered from the media server", async () => {
    reset();
    network.ssdp["urn:schemas-upnp-org:device:MediaServer:1"] = [SERVER_LOCATION];
    network.positionInfo = positionInfo("Track Three", "Artist Three", "Album Three",
        "http://10.0.0.30/Album/cut-off", "http://10.0.0.30/Deep/03.flac", "00:03:00", "00:00:00");
    network.searchResult =
        "<Result>&lt;DIDL-Lite&gt;&lt;upnp:albumArtURI&gt;http://10.0.0.30/Deep/whole.jpg&lt;/upnp:albumArtURI&gt;&lt;/DIDL-Lite&gt;</Result>";
    network.art["http://10.0.0.30/Deep/whole.jpg"] = "COVER-RECOVERED";
    await poll();

    assert.strictEqual(lastActivity().details, "Track Three");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-RECOVERED");
});

test("a track with no cover art anywhere still reaches Discord", async () => {
    reset();
    network.searchResult = null;
    network.positionInfo = positionInfo("Track Four", "Artist Four", "Album Four",
        "http://10.0.0.30/Nowhere/art.jpg", "http://10.0.0.30/Nowhere/04.flac", "00:03:00", "00:00:00");
    await poll();

    assert.strictEqual(lastActivity().details, "Track Four");
    assert.strictEqual(lastActivity().largeImageKey, undefined);
});

test("a renderer that stops answering is rediscovered", async () => {
    reset();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
        if (url === CONTROL) return Promise.reject(new Error("ECONNREFUSED"));
        return realFetch(url, options);
    };
    await poll();
    globalThis.fetch = realFetch;

    // The port a LinkPlay renderer serves on moves after a reboot, so the next poll has
    // to go looking again rather than keep hammering a dead URL. A new track proves the
    // whole path came back, not just the SSDP search.
    reset();
    network.positionInfo = positionInfo("Track Five", "Artist Five", "Album Five",
        "http://10.0.0.30/Album/art.jpg", "http://10.0.0.30/Album/05.flac", "00:03:00", "00:00:00");
    await poll();
    assert.ok(captured.ssdpSearches.includes("urn:schemas-upnp-org:device:MediaRenderer:1"),
        "kept using a control URL that had stopped answering");
    assert.strictEqual(lastActivity().details, "Track Five");
});
