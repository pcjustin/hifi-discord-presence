"use strict";

const fs = require("fs");
const path = require("path");

const SOURCES = ["foobar2000", "roon", "upnp"];
const CONFIG_FILE = path.join(__dirname, "config.json");
const PLACEHOLDER_ID = "YOUR_DISCORD_APPLICATION_ID";

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

const multiMode = config.discordClientIds && typeof config.discordClientIds === "object" &&
    !Array.isArray(config.discordClientIds);

if (!multiMode && !SOURCES.includes(config.source)) {
    console.error('Set "source" in config.json to one of: ' + SOURCES.join(", "));
    process.exit(1);
}

if (multiMode) {
    const unknown = Object.keys(config.discordClientIds).filter((name) => !SOURCES.includes(name));
    if (unknown.length) {
        console.error("Unknown source(s) in discordClientIds: " + unknown.join(", "));
        console.error("Valid sources are: " + SOURCES.join(", "));
        process.exit(1);
    }
}

// Listing runs before anything else is set up: it needs no Discord and no ports, and its
// output is read by a person rather than tailed from a log.
if (process.argv.includes("--list")) {
    const listSource = multiMode ? "upnp" : config.source;
    const source = require("./sources/" + listSource);
    if (!source.list) {
        console.error("--list is not supported by the " + listSource + " source.");
        process.exit(1);
    }
    source.list();
    return;
}

const origLog = console.log;
const origError = console.error;
console.log = (...args) => origLog(new Date().toISOString(), ...args);
console.error = (...args) => origError(new Date().toISOString(), ...args);

const presence = require("./presence");

if (multiMode) {
    const clientIds = Object.fromEntries(SOURCES
        .filter((name) => config.discordClientIds[name] && config.discordClientIds[name] !== PLACEHOLDER_ID)
        .map((name) => [name, config.discordClientIds[name]]));
    const enabledSources = Object.keys(clientIds);
    if (!enabledSources.length) {
        console.error("Set at least one ID in discordClientIds in config.json first (see README.md).");
        process.exit(1);
    }

    console.log("Hi-Fi Discord Presence starting, sources " + enabledSources.join(", ") + ", pid " + process.pid);
    presence.start(Object.assign({}, config, { discordClientIds: clientIds }));
    for (const name of enabledSources) {
        require("./sources/" + name).start(config, (track) => presence.update(name, track));
    }
} else {
    if (!config.discordClientId || config.discordClientId === PLACEHOLDER_ID) {
        console.error("Set discordClientId in config.json first (see README.md).");
        process.exit(1);
    }

    console.log("Hi-Fi Discord Presence starting, source " + config.source + ", pid " + process.pid);
    presence.start(config);
    require("./sources/" + config.source).start(config, presence.update);
}
