"use strict";

const fs = require("fs");
const path = require("path");

const SOURCES = ["foobar2000", "roon", "upnp"];
const CONFIG_FILE = path.join(__dirname, "config.json");

let config;
try {
    // The BOM strip is for Notepad, which saves UTF-8 with one and makes JSON.parse
    // throw on a file the user has no reason to think is wrong. The catch matters
    // because the launcher restarts this process every 15s: an unhandled read error
    // fills the log with the same stack trace instead of saying what to do about it.
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
    console.error("Could not read " + CONFIG_FILE + " - " + err.message);
    console.error("Copy config.example.json to config.json and fill it in (see README.md).");
    process.exit(1);
}

if (!SOURCES.includes(config.source)) {
    console.error('Set "source" in config.json to one of: ' + SOURCES.join(", "));
    process.exit(1);
}

const source = require("./sources/" + config.source);

// Listing runs before anything else is set up: it needs no Discord and no ports, and its
// output is read by a person rather than tailed from a log.
if (process.argv.includes("--list")) {
    if (!source.list) {
        console.error("--list is not supported by the " + config.source + " source.");
        process.exit(1);
    }
    source.list();
    return;
}

const origLog = console.log;
const origError = console.error;
console.log = (...args) => origLog(new Date().toISOString(), ...args);
console.error = (...args) => origError(new Date().toISOString(), ...args);

if (!config.discordClientId || config.discordClientId === "YOUR_DISCORD_APPLICATION_ID") {
    console.error("Set discordClientId in config.json first (see README.md).");
    process.exit(1);
}

console.log("Hi-Fi Discord Presence starting, source " + config.source + ", pid " + process.pid);

const presence = require("./presence");
presence.start(config);
source.start(config, presence.update);
