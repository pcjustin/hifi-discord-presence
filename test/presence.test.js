"use strict";

// The two shared decisions every source now delegates: when an update is worth sending
// to Discord at all, and how a line is trimmed to what Discord will accept.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// presence.js pulls in the Discord packages at load time; only the pure helpers are
// under test here, so they are stubbed rather than installed.
const fakes = {
    "@xhayper/discord-rpc": { Client: class {} },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.call(this, request, ...rest);
};
const { presenceDrift, formatLine, SEEK_TOLERANCE } = require("../presence.js");
Module._load = origLoad;

// A track as the core holds it: `at` is when `position` was read.
const showing = { id: "http://10.0.0.30/a.flac", position: 30, at: 1_000_000 };

test("normal playback does not resend the presence", () => {
    // Five seconds later the source is five seconds further in, as expected.
    assert.strictEqual(presenceDrift(showing, { id: showing.id, position: 35 }, 1_005_000), 0);
});

test("an update that arrives late is still normal playback", () => {
    // Timers slip; a second of slack must not read as a seek.
    const drift = presenceDrift(showing, { id: showing.id, position: 35 }, 1_006_200);
    assert.ok(drift < SEEK_TOLERANCE, "drift was " + drift);
});

test("dragging the timeline forwards or backwards is a seek", () => {
    assert.ok(presenceDrift(showing, { id: showing.id, position: 90 }, 1_005_000) >= SEEK_TOLERANCE);
    assert.ok(presenceDrift(showing, { id: showing.id, position: 2 }, 1_005_000) >= SEEK_TOLERANCE);
});

test("a different track always needs a new payload", () => {
    // Infinity, not a large number: no tolerance should ever suppress a track change,
    // including one that happens to land at a similar position.
    assert.strictEqual(presenceDrift(showing, { id: "http://10.0.0.30/b.flac", position: 31 }, 1_005_000), Infinity);
    assert.strictEqual(presenceDrift(null, { id: showing.id, position: 0 }, 1_005_000), Infinity);
});

test("repeating the same track counts as a change", () => {
    // Same id, but the position went back to the start - a seek by any measure.
    assert.ok(presenceDrift(showing, { id: showing.id, position: 0 }, 1_005_000) >= SEEK_TOLERANCE);
});

test("formatLine keeps Discord's length limits", () => {
    assert.strictEqual(formatLine("愛"), "愛 ");
    assert.strictEqual(formatLine("x".repeat(200)).length, 128);
    assert.strictEqual(formatLine(undefined), undefined);
});
