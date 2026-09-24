"use strict";

const http = require("http");
const crypto = require("crypto");

// %path% is requested only as a stable identity for the cover cache: unlike a playlist
// index it survives reordering, and it tells apart two files whose artist/title/album
// happen to be identical.
const COLUMNS = ["%artist%", "%title%", "%album%", "%path%"];

function trackKey(item) {
    return crypto.createHash("sha1").update((item.columns || []).join(" ")).digest("hex").slice(0, 16);
}

function activeOutputName(outputs) {
    if (!outputs || !outputs.active) return undefined;
    const type = (outputs.types || []).find((candidate) => candidate.id === outputs.active.typeId);
    const device = type && (type.devices || []).find((candidate) => candidate.id === outputs.active.deviceId);
    return device && device.name;
}

// beefweb resends only what changed, so a position tick arrives as an activeItem
// carrying little more than a position. Merging rather than replacing keeps the track's
// columns from vanishing between ticks.
function mergePlayer(player, update) {
    const prevItem = player ? player.activeItem : null;
    const merged = Object.assign({}, player, update);
    if (update.activeItem) merged.activeItem = Object.assign({}, prevItem, update.activeItem);
    return merged;
}

// Server-sent events arrive as blocks of "data:" lines separated by a blank line.
function parseEventBlock(block) {
    const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
    if (!data) return null; // keepalive/comment blocks carry no data line
    try {
        return JSON.parse(data);
    } catch (err) {
        console.error("Ignoring unparsable beefweb event:", err.message);
        return null;
    }
}

function start(config, push) {
    const base = (config.beefwebUrl || "http://127.0.0.1:8880").replace(/\/+$/, "");
    const updatesUrl =
        base + "/api/query/updates?player=true&outputs=true&trcolumns=" + encodeURIComponent(COLUMNS.join(","));
    let player = null;
    let outputs = null;

    const emit = () => {
        const item = player && player.playbackState === "playing" ? player.activeItem : null;
        if (!item) {
            push(null);
            return;
        }
        const [artist, title, album] = item.columns || [];
        const key = trackKey(item);
        push({
            id: key,
            title,
            artist,
            album,
            device: activeOutputName(outputs),
            duration: item.duration,
            position: item.position || 0,
            artKey: key,
            getArt: () => fetchArtwork(base, item),
        });
    };

    // Plain http only: beefweb listens on the local machine. ponytail: a remote HTTPS
    // beefweb would need require("https") here - add it when someone actually runs one.
    (function connect() {
        let buf = "";
        let retried = false;
        const retry = (why) => {
            if (retried) return;
            retried = true;
            console.error("beefweb unavailable (" + why + "), retrying in 15s...");
            player = null;
            outputs = null;
            push(null);
            setTimeout(connect, 15000);
        };

        const req = http.get(updatesUrl, { headers: { Accept: "text/event-stream" } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                retry("HTTP " + res.statusCode + " - is the Beefweb component installed and its API enabled?");
                return;
            }
            console.log("Connected to beefweb at " + base);
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                buf += chunk;
                for (;;) {
                    const boundary = /\r?\n\r?\n/.exec(buf);
                    if (!boundary) break;
                    const msg = parseEventBlock(buf.slice(0, boundary.index));
                    buf = buf.slice(boundary.index + boundary[0].length);
                    if (msg) {
                        if (msg.player) player = mergePlayer(player, msg.player);
                        if (Object.prototype.hasOwnProperty.call(msg, "outputs")) outputs = msg.outputs;
                        if (player && (msg.player || Object.prototype.hasOwnProperty.call(msg, "outputs"))) emit();
                    }
                }
            });
            res.on("end", () => retry("stream ended - foobar2000 closed?"));
            res.on("error", (err) => retry(err.message));
        });
        req.on("error", (err) => retry(err.message));
    })();
}

function fetchArtwork(base, item) {
    const url = base + "/api/artwork/" + encodeURIComponent(item.playlistId) + "/" + item.index;
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            // 404 is the ordinary answer for a track with no embedded or folder art, so
            // it is recorded as "no cover" without an error line - otherwise a library
            // with untagged art fills the log.
            if (res.statusCode !== 200) {
                res.resume();
                if (res.statusCode === 404) resolve(null);
                else reject(new Error("HTTP " + res.statusCode + " from " + url));
                return;
            }
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: res.headers["content-type"] || "image/jpeg",
            }));
            res.on("error", reject);
        });
        req.on("error", reject);
    });
}

module.exports = { start, trackKey, mergePlayer, parseEventBlock };
