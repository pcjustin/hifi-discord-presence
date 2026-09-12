"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { plist, installCloudflared } = require("../install-support");

function directory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hifi-install-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("a working cloudflared is retained without downloading", (t) => {
    const dir = directory(t);
    const target = path.join(dir, "cloudflared.exe");
    fs.writeFileSync(target, "working binary");
    installCloudflared(dir, (file, args) => {
        assert.equal(file, target);
        assert.deepEqual(args, ["--version"]);
        return "cloudflared version 2026.1.0\n";
    });
    assert.deepEqual(fs.readdirSync(dir), ["cloudflared.exe"]);
    assert.equal(fs.readFileSync(target, "utf8"), "working binary");
});

for (const existing of [false, true]) {
    test(`a failed download leaves no staging files (existing file: ${existing})`, (t) => {
        const dir = directory(t);
        const target = path.join(dir, "cloudflared.exe");
        if (existing) fs.writeFileSync(target, "old broken binary");
        assert.throws(() => installCloudflared(dir, (file, args) => {
            if (file !== "curl.exe") throw new Error("Invalid executable");
            assert.ok(args.includes("--fail"));
            fs.writeFileSync(args[args.indexOf("--output") + 1], "partial download");
            throw new Error("HTTP 404");
        }), /HTTP 404/);
        assert.deepEqual(fs.readdirSync(dir), existing ? ["cloudflared.exe"] : []);
        if (existing) assert.equal(fs.readFileSync(target, "utf8"), "old broken binary");
    });
}

test("an invalid downloaded executable is rejected", (t) => {
    const dir = directory(t);
    assert.throws(() => installCloudflared(dir, (file, args) => {
        if (file !== "curl.exe") return "Not Found";
        fs.writeFileSync(args[args.indexOf("--output") + 1], "Not Found");
    }), /version check/);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test("a verified download repairs a broken existing installation", (t) => {
    const dir = directory(t);
    const target = path.join(dir, "cloudflared.exe");
    fs.writeFileSync(target, "broken");
    installCloudflared(dir, (file, args) => {
        if (file === target) throw new Error("Invalid executable");
        if (file === "curl.exe") {
            assert.ok(args.includes("--fail"));
            fs.writeFileSync(args[args.indexOf("--output") + 1], "new binary");
        } else {
            assert.equal(fs.readFileSync(target, "utf8"), "broken");
            return "cloudflared version 2026.1.0";
        }
    });
    assert.deepEqual(fs.readdirSync(dir), ["cloudflared.exe"]);
    assert.equal(fs.readFileSync(target, "utf8"), "new binary");
});

test("plist paths are escaped as XML text", () => {
    const xml = plist('/node & <tool>', '/Music & Apps/<HiFi>', '/logs/a&b', 'hifi');
    assert.ok(xml.includes('<string>/Music &amp; Apps/&lt;HiFi&gt;/index.js</string>'));
    assert.ok(xml.includes('<string>/logs/a&amp;b</string>'));
});

test("macOS parses generated plist paths without changing their contents", { skip: process.platform !== "darwin" }, () => {
    const node = '/Applications/音樂 & "Tools"/<node>';
    const dir = '/Users/test/Music & Apps/<HiFi>';
    const log = '/Users/test/Logs/a&b.log';
    const xml = plist(node, dir, log, 'hifi');
    const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }));
    assert.deepEqual(parsed.ProgramArguments, [node, path.join(dir, 'index.js')]);
    assert.equal(parsed.WorkingDirectory, dir);
    assert.equal(parsed.StandardOutPath, log);
    assert.equal(parsed.KeepAlive, true);
});
