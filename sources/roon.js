"use strict";

const fs = require("fs");
const path = require("path");

// The Roon SDK's default persisted-state store is a relative "config.json" in the
// process's working directory - i.e. our own config file. It rewrites that file on every
// pairing, so any hiccup reading it drops the Discord application IDs and the next
// launch exits at the config check. Own state file, absolute path, no overlap.
const STATE_FILE = path.join(__dirname, "..", "roonstate.json");

// Roon has no track id, so identity is the three lines it displays. Two plays of the
// same track in a row share an id, but the position resets, which reads as a seek and
// still refreshes the presence.
function zoneTrack(zone, core) {
    const np = zone.now_playing;
    const line = np.three_line;
    return {
        id: [line.line1, line.line2, line.line3].join("|"),
        title: line.line1,
        artist: line.line2,
        album: line.line3,
        duration: np.length,
        position: np.seek_position || 0,
        artKey: np.image_key || null,
        getArt: () => fetchImage(core, np.image_key),
    };
}

function fetchImage(core, imageKey) {
    return new Promise((resolve, reject) => {
        core.services.RoonApiImage.get_image(
            imageKey,
            { scale: "fit", width: 512, height: 512, format: "image/jpeg" },
            (err, contentType, image) => (err ? reject(new Error(String(err))) : resolve({ buffer: image, contentType }))
        );
    });
}

function start(config, push) {
    const RoonApi = require("node-roon-api");
    const RoonApiStatus = require("node-roon-api-status");
    const RoonApiTransport = require("node-roon-api-transport");
    const RoonApiImage = require("node-roon-api-image");

    let zones = {};
    let core = null;

    const emit = () => {
        const playing = Object.values(zones).find((z) => z.state === "playing" && z.now_playing);
        push(playing && core ? zoneTrack(playing, core) : null);
    };

    const roon = new RoonApi({
        extension_id: "com.pcjustin.hifi_discord_presence",
        // Names the entry in Roon's Settings > Extensions list, not the "Listening to"
        // line - that comes from the Discord application. Distinct from the separate
        // extensions this project was merged from, which are still registered on Cores
        // that ran them and would otherwise be indistinguishable in that list.
        display_name: "Hi-Fi Discord Presence",
        display_version: "1.0.2",
        publisher: "Justin Lu",
        email: "pcjustin@icloud.com",
        get_persisted_state: () => {
            try {
                return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
            } catch {
                return {};
            }
        },
        set_persisted_state: (state) => {
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 4));
        },
        core_paired: (paired) => {
            console.log("Paired with Roon Core:", paired.display_name);
            core = paired;
            paired.services.RoonApiTransport.subscribe_zones((response, msg) => {
                if (response === "Subscribed") {
                    zones = msg.zones.reduce((acc, z) => ((acc[z.zone_id] = z), acc), {});
                } else if (response === "Changed") {
                    (msg.zones_added || []).forEach((z) => (zones[z.zone_id] = z));
                    (msg.zones_changed || []).forEach((z) => (zones[z.zone_id] = z));
                    (msg.zones_removed || []).forEach((id) => delete zones[id]);
                    // Seek-only messages carry the position outside the zone object.
                    // The SDK usually has it folded in already (its cache aliases these
                    // objects), but doing it here does not depend on that.
                    (msg.zones_seek_changed || []).forEach((e) => {
                        const zone = zones[e.zone_id];
                        if (zone && zone.now_playing) zone.now_playing.seek_position = e.seek_position;
                    });
                } else {
                    return;
                }
                emit();
            });
        },
        core_unpaired: (unpaired) => {
            console.log("Unpaired from Roon Core:", unpaired.display_name);
            core = null;
            zones = {};
            push(null);
        },
    });

    const svcStatus = new RoonApiStatus(roon);
    roon.init_services({
        required_services: [RoonApiTransport, RoonApiImage],
        provided_services: [svcStatus],
    });
    svcStatus.set_status("Waiting for Roon Core...", false);
    roon.start_discovery();

    // Roon holds the register request open with no reply until the extension is enabled
    // in Settings > Extensions, so without this the log just stops after
    // "-> REQUEST ... /register" and looks like a failure rather than "your turn".
    setTimeout(() => {
        if (!core) console.log('Not paired yet - open Roon Settings > Extensions and enable "Hi-Fi Discord Presence".');
    }, 30000).unref();
}

module.exports = { start, zoneTrack };
