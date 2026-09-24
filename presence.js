"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { ActivityType } = require("discord-api-types/v10");

const IMAGE_PORT = 47122;
const IMAGE_CACHE_MAX = 10;
const ART_TIMEOUT_MS = 5000;
const RPC_TIMEOUT_MS = 5000;
// Playback advances by about one update interval between updates; dragging the
// timeline jumps much further, or backwards. Anything past this is a manual seek.
const SEEK_TOLERANCE = 5;

// Discord rejects the whole SET_ACTIVITY payload if name/details/state/largeImageText is
// 1 character or longer than 128 - the update is dropped and the track never appears.
// Both ends occur in a real library: single-character CJK titles, and classical track
// names that run well past 128 characters.
function formatLine(line) {
    if (!line) return undefined;
    if (line.length === 1) return line + " ";
    return line.slice(0, 128);
}

// How far the source's position has drifted from what Discord is already showing.
// Infinity for a different track, which always needs a new payload. Sources push an
// update per position tick (once a second for beefweb and Roon, once a poll for
// UPnP); resending setActivity for each would spend Discord's rate budget for no
// visible gain, since startTimestamp already lets Discord tick the bar client-side.
// A manual seek does have to reach Discord, and shows up here as a large drift.
function presenceDrift(current, next, now) {
    if (!current || current.id !== next.id) return Infinity;
    return Math.abs(next.position - (current.position + (now - current.at) / 1000));
}

module.exports = { start, update, stopTunnel, formatLine, presenceDrift, SEEK_TOLERANCE, IMAGE_PORT };

let rpc = null;
let discordReady = false;
let rpcClientId = null;
let rpcGeneration = 0;
let rpcCleanup = null;
let reconnectTimer = null;
let tunnelUrl = null;
let tunnelProcess = null;
let tunnelRetry = null;
let stopping = false;
let current = null;
let presenceTimer = null;
let presenceRetry = null;
let publicationAttempt = 0;
let activeSource = null;
let legacySource = null;
let clientIds = {};
let activationSequence = 0;
const sourceStates = new Map(); // source -> { track, observedAt, activatedAt }

const images = new Map(); // artKey -> { value, waiting, timer }

function withTimeout(operation) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Discord request timed out")), RPC_TIMEOUT_MS);
        Promise.resolve().then(operation).then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

function start(config) {
    if (config.discordClientIds) {
        clientIds = Object.assign({}, config.discordClientIds);
    } else {
        legacySource = config.source || "default";
        clientIds = { [legacySource]: config.discordClientId };
        activeSource = legacySource;
        switchDiscordClient(legacySource);
    }

    startImageServer();
}

// Each Discord application has its own display name, so changing player means changing
// RPC client as well as changing the track. Only the active source is connected; three
// simultaneous SET_ACTIVITY streams with the same process id would continually replace
// one another in Discord.
function switchDiscordClient(sourceName) {
    const wantedId = clientIds[sourceName];
    if (!wantedId) return;
    if (rpc && rpcClientId === wantedId) {
        schedulePush();
        return;
    }

    const old = rpc;
    rpc = null;
    discordReady = false;
    rpcClientId = wantedId;
    clearTimeout(reconnectTimer);
    clearTimeout(presenceRetry);
    const generation = ++rpcGeneration;

    const connect = () => {
        if (generation !== rpcGeneration || clientIds[activeSource] !== wantedId) return;
        const { Client: DiscordClient } = require("@xhayper/discord-rpc");
        // discord-rpc clients cache their connect() promise for one attempt. A fresh
        // Client is therefore required both for retries and for another application ID.
        const client = new DiscordClient({ clientId: wantedId, transport: "ipc" });
        rpc = client;

        const retry = (message, err) => {
            if (generation !== rpcGeneration || rpc !== client || clientIds[activeSource] !== wantedId) return;
            discordReady = false;
            rpc = null;
            console.error(message, err ? err.message : "");
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 15000);
        };

        client.on("ready", () => {
            if (generation !== rpcGeneration || rpc !== client || clientIds[activeSource] !== wantedId) return;
            discordReady = true;
            console.log("Connected to Discord for " + activeSource + ".");
            schedulePush();
        });
        client.on("disconnected", () => retry("Discord connection closed, reconnecting in 15s..."));
        client.login().catch((err) => retry("Discord connect failed, retrying in 15s:", err));
    };

    if (old) {
        // Retain cleanup across switches that arrive while rpc is temporarily null.
        const clear = old.user ? withTimeout(() => old.user.clearActivity()).catch(() => {}) : Promise.resolve();
        const cleanup = clear
            .then(() => withTimeout(() => typeof old.destroy === "function" ? old.destroy() : undefined))
            .catch(() => {});
        rpcCleanup = cleanup;
        cleanup.then(() => {
            if (rpcCleanup === cleanup) rpcCleanup = null;
        });
    }
    if (rpcCleanup) rpcCleanup.then(connect);
    else connect();
}

// --- Cover art: the art lives somewhere Discord's client cannot reach (embedded in a
// local file, inside Roon, on a NAS at a LAN address), so the bytes are cached here and
// published through a cloudflared quick tunnel, and that public URL is what Discord is
// given for largeImageKey.
function startImageServer() {
    const server = http.createServer((req, res) => {
        const key = new URL(req.url, "http://127.0.0.1").searchParams.get("k");
        const img = key && images.get(key)?.value;
        if (!img) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { "Content-Type": img.contentType, "Cache-Control": "no-store" });
        res.end(img.buffer);
    });
    server.on("error", (err) => {
        // Doubles as a single-instance check: the launcher restarts this process, so a
        // second copy would otherwise respawn forever fighting the first over Discord.
        console.error("Image server could not listen on port " + IMAGE_PORT + " (already running?):", err.message);
        process.exit(1);
    });
    server.listen(IMAGE_PORT, "127.0.0.1", startTunnel);
}

function startTunnel() {
    if (stopping) return;
    const local = path.join(__dirname, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    const bin = fs.existsSync(local) ? local : "cloudflared";
    const cloudflared = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${IMAGE_PORT}`], { windowsHide: true });
    tunnelProcess = cloudflared;
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let spawnFailed = false;

    const onOutput = (data) => {
        const match = data.toString().match(urlRegex);
        if (match && !tunnelUrl) {
            tunnelUrl = match[0];
            console.log("Cover art tunnel ready:", tunnelUrl);
            schedulePush();
        }
    };
    cloudflared.stdout.on("data", onOutput);
    cloudflared.stderr.on("data", onOutput);

    cloudflared.on("error", (err) => {
        spawnFailed = true;
        console.error("cloudflared failed to start (cover art will be unavailable):", err.message);
    });
    cloudflared.on("exit", (code) => {
        if (tunnelProcess === cloudflared) tunnelProcess = null;
        tunnelUrl = null;
        // Whether 'exit' fires after a failed spawn (missing binary) is unspecified by
        // Node and varies by platform, so spawnFailed makes the no-retry decision
        // explicit instead of relying on 'exit' simply not firing.
        if (spawnFailed || stopping) return;
        console.error("cloudflared exited (code " + code + "), restarting in 3s...");
        tunnelRetry = setTimeout(startTunnel, 3000);
    });
}

function stopTunnel() {
    stopping = true;
    clearTimeout(tunnelRetry);
    if (tunnelProcess) {
        tunnelProcess.kill();
        tunnelProcess = null;
    }
}

function maybeFetchArt(track) {
    const key = track.artKey;
    if (!key || !track.getArt || images.has(key)) return;
    const entry = { value: null, waiting: true, timer: null };
    images.set(key, entry);
    if (images.size > IMAGE_CACHE_MAX) {
        const oldest = images.keys().next().value;
        clearTimeout(images.get(oldest).timer);
        images.delete(oldest);
    }
    const finish = (value, err) => {
        clearTimeout(entry.timer);
        if (images.get(key) !== entry) return;
        entry.waiting = false;
        entry.value = value;
        if (err) console.error("Failed to fetch cover art:", err);
        if (current?.artKey === key) schedulePush();
    };
    // The deadline releases the text update; the same request may still deliver art.
    entry.timer = setTimeout(() => {
        entry.waiting = false;
        console.error("Cover art fetch timed out, showing track without art.");
        if (current?.artKey === key) schedulePush();
    }, ART_TIMEOUT_MS);

    // Called, not wrapped in Promise.resolve().then(): a source that starts its request
    // synchronously should have done so by the time this returns, so a caller can see
    // the request in flight rather than one microtask later.
    try {
        Promise.resolve(track.getArt()).then((value) => finish(value || null), (err) => finish(null, err.message));
    } catch (err) {
        finish(null, err.message);
    }
}

// Sources call update(source, track) in multi-source mode. A newly playing source takes
// over; routine position ticks from another player do not. When the selected player
// stops, the most recently active player that is still running becomes the fallback.
// update(track) remains the legacy single-source API.
function update(sourceOrTrack, maybeTrack) {
    const named = arguments.length > 1;
    const sourceName = named ? sourceOrTrack : legacySource;
    const next = named ? maybeTrack : sourceOrTrack;
    if (!sourceName || !clientIds[sourceName]) return;

    const now = Date.now();
    const state = sourceStates.get(sourceName) || { track: null, observedAt: now, activatedAt: 0 };
    const previous = state.track;
    const expectedPosition = previous ? previous.position + (now - state.observedAt) / 1000 : 0;
    const started = Boolean(next) && (!previous || previous.id !== next.id ||
        previous.title !== next.title || previous.artist !== next.artist || previous.album !== next.album ||
        next.position + SEEK_TOLERANCE < expectedPosition);
    state.track = next;
    state.observedAt = now;
    sourceStates.set(sourceName, state);

    if (!next) {
        if (activeSource !== sourceName || !previous) return;
        const fallback = [...sourceStates.entries()]
            .filter(([, value]) => value.track)
            .sort((a, b) => b[1].activatedAt - a[1].activatedAt)[0];
        if (fallback) {
            activateSource(fallback[0], fallback[1]);
        } else {
            current = null;
            schedulePush();
        }
        return;
    }

    if (activeSource !== sourceName) {
        if (!started) return;
        state.activatedAt = ++activationSequence;
        activateSource(sourceName, state);
        return;
    }
    if (started) state.activatedAt = ++activationSequence;
    updateCurrent(sourceName, next);
}

function activateSource(sourceName, state) {
    if (activeSource !== sourceName) console.log("Active source changed to " + sourceName + ".");
    activeSource = sourceName;
    current = null;
    switchDiscordClient(sourceName);
    updateCurrent(sourceName, state.track);
}

function updateCurrent(sourceName, next) {
    // Scope identities by source so unrelated players cannot share a cover cache entry
    // merely because their own key algorithms happened to return the same string.
    next = Object.assign({}, next, {
        id: sourceName + "::" + next.id,
        artKey: next.artKey ? sourceName + "::" + next.artKey : null,
    });
    const drift = presenceDrift(current, next, Date.now());
    const metadataChanged = !current || ["title", "artist", "album", "duration", "artKey"]
        .some((field) => current[field] !== next[field]);
    if (drift < SEEK_TOLERANCE && !metadataChanged) return;
    if (Number.isFinite(drift) && drift >= SEEK_TOLERANCE) console.log("Seek detected, drift " + Math.round(drift) + "s");
    next.at = Date.now();
    current = next;
    schedulePush();
}

// A track transition can emit a burst of closely-spaced events (the old track stopping,
// then the new one starting; a gapless handoff). Sending setActivity for each one risks
// tripping Discord's RPC rate limit and losing the update that actually matters.
function schedulePush() {
    clearTimeout(presenceTimer);
    clearTimeout(presenceRetry);
    presenceTimer = setTimeout(pushPresence, 300);
}

function sendPresence(activity) {
    const client = rpc;
    const track = current;
    const attempt = ++publicationAttempt;
    const failed = (err) => {
        if (rpc !== client || current !== track || attempt !== publicationAttempt || !discordReady) return;
        console.error("Failed to update Discord activity, retrying in 5s:", err.message);
        clearTimeout(presenceRetry);
        presenceRetry = setTimeout(pushPresence, RPC_TIMEOUT_MS);
    };
    try {
        const request = activity ? client.user.setActivity(activity) : client.user.clearActivity();
        Promise.resolve(request).catch(failed);
    } catch (err) {
        failed(err);
    }
}

function pushPresence() {
    clearTimeout(presenceRetry);
    // rpc.user comes from the READY dispatch and is normally always present for a local
    // IPC login, but the library sets it conditionally - and rpc.user.setActivity would
    // throw synchronously, before .catch can attach, and crash the process.
    if (!discordReady || !rpc || !rpc.user) return;

    const track = current;
    if (!track) {
        sendPresence(null);
        return;
    }

    maybeFetchArt(track);
    if (images.get(track.artKey)?.waiting) return;

    const hasArt = Boolean(tunnelUrl && track.artKey && images.get(track.artKey)?.value);
    console.log(
        "Presence update:", track.title,
        "| key=" + (track.artKey || "none"),
        "| tunnelUrl=" + (tunnelUrl || "none"),
        "| hasArt=" + hasArt
    );

    const start = track.at - track.position * 1000;
    // type: Listening is what makes Discord render the Spotify-style progress bar with
    // elapsed/remaining instead of plain "Playing" text.
    sendPresence({
        type: ActivityType.Listening,
        statusDisplayType: 2,
        details: formatLine(track.title),
        state: formatLine(track.album),
        startTimestamp: start,
        // Internet radio reports a duration of -1 or 0; leaving endTimestamp off makes
        // Discord show a plain elapsed counter instead of a progress bar to nowhere.
        endTimestamp: track.duration > 0 ? start + track.duration * 1000 : undefined,
        largeImageKey: hasArt ? `${tunnelUrl}/?k=${encodeURIComponent(track.artKey)}` : undefined,
        largeImageText: formatLine(track.artist),
        instance: false,
    });
}
