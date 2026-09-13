"use strict";

const http = require("http");

function start(config, push) {
    const port = Number(config.youtubePort) || 47123;
    let state = null;
    const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.method === "GET" && req.url === "/state") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(state));
            return;
        }
        if (req.method !== "POST" || req.url !== "/state") { res.writeHead(404); res.end(); return; }
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            try {
                const next = JSON.parse(body);
                if (!next || !next.title || !next.playing) {
                    state = null;
                    push(null);
                } else {
                    state = next;
                    push({
                        id: next.id || next.url || next.title,
                        title: next.title,
                        artist: next.artist || "YouTube",
                        album: "YouTube",
                        duration: Number(next.duration) || 0,
                        position: Number(next.position) || 0,
                        artKey: next.art || null,
                        getArt: () => fetchArt(next.art),
                    });
                }
                res.writeHead(204); res.end();
            } catch (err) { res.writeHead(400); res.end(err.message); }
        });
    });
    server.on("error", (err) => console.error("YouTube listener failed:", err.message));
    server.listen(port, "127.0.0.1", () => console.log("YouTube listener ready on port " + port + "."));
}

async function fetchArt(url) {
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "image/jpeg" };
}

module.exports = { start };
