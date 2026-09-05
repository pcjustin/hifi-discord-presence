"use strict";

const dgram = require("dgram");
const crypto = require("crypto");

const POLL_MS = 5000;
const AVTRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const CONTENT_DIRECTORY = "urn:schemas-upnp-org:service:ContentDirectory:1";
const RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";
const SERVER_ST = "urn:schemas-upnp-org:device:MediaServer:1";

// --- Pure parsing helpers ---

// Entities arrive doubly encoded: TrackMetaData is an escaped XML document, and the text
// inside it was escaped once more before that. &amp; is decoded last, otherwise
// "&amp;lt;" would turn into a "<" that was never in the original text.
function decode(s) {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function tag(xml, name) {
    const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(xml);
    return m ? m[1] : undefined;
}

function hms(value) {
    if (!value) return 0;
    const parts = value.split(":").map(Number);
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// upnp:artist repeats for multi-artist tracks and dc:creator is not always present, so
// fall back through both rather than trusting either one alone.
function parseTrack(positionInfoXml) {
    const didl = decode(tag(positionInfoXml, "TrackMetaData") || "");
    const field = (name) => {
        const v = tag(didl, name);
        return v ? decode(v).trim() : undefined;
    };
    const uri = tag(positionInfoXml, "TrackURI");
    const title = field("dc:title");
    if (!title) return null;
    return {
        title,
        artist: field("upnp:artist") || field("dc:creator"),
        album: field("upnp:album"),
        art: field("upnp:albumArtURI"),
        duration: hms(tag(positionInfoXml, "TrackDuration")),
        position: hms(tag(positionInfoXml, "RelTime")),
        // TrackURI, not the title: the same title can repeat across an album (hidden
        // tracks, multi-disc rips) and repeating a track must still count as a change.
        id: uri || title,
    };
}

// MinimServer advertises the embedded picture of the album's first track, which 404s for
// albums whose art sits beside the files as an image instead of inside them - so the
// folder image is tried next rather than giving up on a broken advertised URL.
function artCandidates(track) {
    const dir = /^https?:/.test(track.id) ? track.id.replace(/\/[^/]*$/, "") : null;
    return [track.art, dir && dir + "/cover.jpg", dir && dir + "/folder.jpg"].filter(Boolean);
}

// A device's own description document is the only place its friendly name appears, and
// the control URL in it may be relative to where the document was fetched from.
function parseDescription(xml, location, wanted = "AVTransport") {
    const service = (xml.match(/<service>[\s\S]*?<\/service>/g) || []).find((s) =>
        (tag(s, "serviceType") || "").includes(wanted)
    );
    if (!service) return null;
    return {
        name: (tag(xml, "friendlyName") || "").trim(),
        control: new URL((tag(service, "controlURL") || "").trim(), location).href,
    };
}

// Substring rather than equality: a friendly name usually carries a serial number the
// owner has no reason to type out. An empty name matches everything, which takes the
// first renderer that answers - the right behaviour on a one-streamer network.
function matchRenderer(renderers, wanted) {
    const needle = (wanted || "").trim().toLowerCase();
    return renderers.find((r) => r.name.toLowerCase().includes(needle)) || null;
}

// A ContentDirectory Search answers with a DIDL-Lite document escaped into <Result>, so
// the art URL sits two layers of entities down.
function artFromSearchResult(xml) {
    const art = tag(decode(tag(xml, "Result") || ""), "upnp:albumArtURI");
    return art ? decode(art).trim() : null;
}

// --- Discovery ---

// LinkPlay-based renderers serve their description on a dynamic port that moves after a
// reboot, so the control URL is discovered rather than configured, and rediscovered
// whenever a request to it fails.
function ssdpSearch(st) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const locations = new Set();
        const msg = Buffer.from(
            "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: 239.255.255.250:1900\r\n" +
            'MAN: "ssdp:discover"\r\n' +
            "MX: 2\r\n" +
            "ST: " + st + "\r\n\r\n"
        );
        sock.on("error", () => {});
        sock.on("message", (buf) => {
            const m = /LOCATION:\s*(\S+)/i.exec(buf.toString());
            if (m) locations.add(m[1]);
        });
        sock.bind(() => {
            sock.send(msg, 1900, "239.255.255.250");
            setTimeout(() => {
                sock.close();
                resolve([...locations]);
            }, 3000);
        });
    });
}

// The friendly name lives in the description document, not in the SSDP reply, so every
// answer has to be fetched before any of them can be matched against rendererName.
async function describeDevices(st, wanted) {
    const devices = [];
    for (const location of await ssdpSearch(st)) {
        let xml;
        try {
            const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
            xml = await res.text();
        } catch {
            continue;
        }
        const device = parseDescription(xml, location, wanted);
        if (device) devices.push(device);
    }
    return devices;
}

async function list() {
    const renderers = await describeDevices(RENDERER_ST, "AVTransport");
    if (!renderers.length) {
        console.log("No UPnP renderer answered. Is the streamer powered up and on this network?");
        return;
    }
    console.log("Renderers on this network. Put a name in config.json as rendererName -");
    console.log("matching is case-insensitive on any part of it, so a distinctive word is enough.\n");
    for (const r of renderers) console.log("  " + r.name + "\n      " + r.control + "\n");
}

function soap(url, service, action, args) {
    const body =
        '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<u:${action} xmlns:u="${service}">${args}</u:${action}>` +
        "</s:Body></s:Envelope>";
    return fetch(url, {
        method: "POST",
        headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` },
        body,
        signal: AbortSignal.timeout(5000),
    }).then((res) => {
        if (!res.ok) throw new Error(action + " returned HTTP " + res.status);
        return res.text();
    });
}

async function fetchFirst(urls) {
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;
            return {
                buffer: Buffer.from(await res.arrayBuffer()),
                contentType: res.headers.get("content-type") || "image/jpeg",
            };
        } catch (err) {
            console.error("Cover art fetch failed:", err.message);
        }
    }
    return null;
}

function start(config, push) {
    let controlUrl = null;
    let contentDirectory = null;
    let lastState = null;
    let polling = false;

    const transport = (action) => soap(controlUrl, AVTRANSPORT, action, "<InstanceID>0</InstanceID>");

    // The renderer truncates every DIDL field at 256 characters, so a deep path - and a
    // CJK one is mostly percent escapes - loses the tail of upnp:albumArtURI and the URL
    // it advertises 404s. TrackURI arrives whole because it is its own SOAP argument, so
    // the media server that wrote the metadata can be asked for the item again by it.
    async function recoverArtUri(track) {
        if (!/^https?:/.test(track.id)) return null;
        try {
            if (!contentDirectory) {
                const host = new URL(track.id).hostname;
                const servers = await describeDevices(SERVER_ST, "ContentDirectory");
                const server = servers.find((s) => new URL(s.control).hostname === host);
                if (!server) return null;
                contentDirectory = server.control;
                console.log("Media server found:", server.name, "-", server.control);
            }
            const criteria = `res = &quot;${track.id.replace(/&/g, "&amp;")}&quot;`;
            const xml = await soap(contentDirectory, CONTENT_DIRECTORY, "Search",
                "<ContainerID>0</ContainerID>" +
                `<SearchCriteria>${criteria}</SearchCriteria>` +
                "<Filter>upnp:albumArtURI</Filter><StartingIndex>0</StartingIndex>" +
                "<RequestedCount>1</RequestedCount><SortCriteria></SortCriteria>");
            return artFromSearchResult(xml);
        } catch (err) {
            console.error("Could not ask the media server for cover art:", err.message);
            contentDirectory = null;
            return null;
        }
    }

    async function getArt(track) {
        const candidates = artCandidates(track);
        if (!candidates.length) return null;
        const value = await fetchFirst(candidates);
        if (value) return value;
        const recovered = await recoverArtUri(track);
        if (recovered) return fetchFirst([recovered]);
        console.error("No cover art found for:", track.title);
        return null;
    }

    async function poll() {
        if (polling) return;
        polling = true;
        try {
            if (!controlUrl) {
                const renderer = matchRenderer(await describeDevices(RENDERER_ST, "AVTransport"), config.rendererName);
                if (!renderer) {
                    console.error("No renderer matching '" + (config.rendererName || "*") + "' on the network.");
                    push(null);
                    return;
                }
                console.log("Renderer found:", renderer.name, "-", renderer.control);
                controlUrl = renderer.control;
            }

            const state = tag(await transport("GetTransportInfo"), "CurrentTransportState");
            // Logged on change only - a poll every few seconds would otherwise repeat it
            // forever while the renderer sits idle. Without it a renderer that drops out
            // of PLAYING to seek looks indistinguishable from a track change.
            if (state !== lastState) console.log("Renderer is " + state + ".");
            lastState = state;
            if (state !== "PLAYING" && state !== "TRANSITIONING") {
                push(null);
                return;
            }

            const track = parseTrack(await transport("GetPositionInfo"));
            if (!track) return;
            const candidates = artCandidates(track);
            push(Object.assign(track, {
                artKey: candidates.length
                    ? crypto.createHash("md5").update(candidates[0]).digest("hex").slice(0, 12)
                    : null,
                getArt: () => getArt(track),
            }));
        } catch (err) {
            console.error("Renderer poll failed:", err.message);
            controlUrl = null;
            push(null);
        } finally {
            polling = false;
        }
    }

    poll();
    setInterval(poll, POLL_MS);
}

module.exports = {
    start, list,
    decode, tag, hms, parseTrack, artCandidates, parseDescription, matchRenderer, artFromSearchResult,
};
