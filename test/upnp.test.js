"use strict";

// Real GetPositionInfo and description documents from the network. They are the only
// input the UPnP source builds a track from, so parsing them is what gets tested.

const test = require("node:test");
const assert = require("node:assert");
const { parseTrack, hms, decode, artFromSearchResult, artCandidates, parseDescription, matchRenderer } =
    require("../sources/upnp.js");

const SAMPLE = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
<Track>0</Track>
<TrackDuration>00:01:47</TrackDuration>
<TrackMetaData>&lt;?xml version=&quot;1.0&quot;?&gt;
&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;
&lt;item id=&quot;0$:albums$*a375&quot; parentID=&quot;0&quot; restricted=&quot;1&quot;&gt;
&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;
&lt;dc:title&gt;Flight to LAPD&lt;/dc:title&gt;
&lt;dc:creator&gt;Benjamin Wallfisch, Hans Zimmer&lt;/dc:creator&gt;
&lt;upnp:artist&gt;Benjamin Wallfisch &amp;amp; Hans Zimmer&lt;/upnp:artist&gt;
&lt;upnp:albumArtURI&gt;http://10.0.0.30:9790/minimserver/*/Music/x.flac/$!pict&lt;/upnp:albumArtURI&gt;
&lt;upnp:album&gt;Blade Runner 2049 (Original Motion Picture Soundtrack)&lt;/upnp:album&gt;
&lt;/item&gt;
&lt;/DIDL-Lite&gt;
</TrackMetaData>
<TrackURI>http://10.0.0.30:9790/minimserver/*/Music/x.flac</TrackURI>
<RelTime>00:00:18</RelTime>
<AbsTime>NOT_IMPLEMENTED</AbsTime>
</u:GetPositionInfoResponse>
</s:Body></s:Envelope>`;

test("parses a playing track out of GetPositionInfo", () => {
    const t = parseTrack(SAMPLE);
    assert.strictEqual(t.title, "Flight to LAPD");
    // The ampersand survives both encoding layers as a single "&".
    assert.strictEqual(t.artist, "Benjamin Wallfisch & Hans Zimmer");
    assert.strictEqual(t.album, "Blade Runner 2049 (Original Motion Picture Soundtrack)");
    assert.strictEqual(t.art, "http://10.0.0.30:9790/minimserver/*/Music/x.flac/$!pict");
    assert.strictEqual(t.duration, 107);
    assert.strictEqual(t.position, 18);
    assert.strictEqual(t.id, "http://10.0.0.30:9790/minimserver/*/Music/x.flac");
});

test("an idle renderer yields no track", () => {
    assert.strictEqual(parseTrack("<TrackMetaData>NOT_IMPLEMENTED</TrackMetaData>"), null);
});

test("hms handles clock strings and junk", () => {
    assert.strictEqual(hms("01:02:03"), 3723);
    assert.strictEqual(hms("NOT_IMPLEMENTED"), 0);
    assert.strictEqual(hms(undefined), 0);
});

test("decode does not invent markup from escaped entities", () => {
    assert.strictEqual(decode("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
});

// The renderer cut this track's upnp:albumArtURI off at 256 characters; the media
// server's own answer to a Search for the same res is where the whole URL comes back.
const SEARCH_RESULT = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:SearchResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<Result>&lt;DIDL-Lite&gt;&lt;item id=&quot;0$1&quot;&gt;&lt;upnp:albumArtURI dlna:profileID=&quot;JPEG_LRG&quot;&gt;http://10.0.0.30:9790/minimserver/*/Music/a&amp;amp;b.flac/$!picture-686-944282.jpg&lt;/upnp:albumArtURI&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</Result>
<NumberReturned>1</NumberReturned>
</u:SearchResponse>
</s:Body></s:Envelope>`;

test("the media server's full art URL survives both entity layers", () => {
    assert.strictEqual(
        artFromSearchResult(SEARCH_RESULT),
        "http://10.0.0.30:9790/minimserver/*/Music/a&b.flac/$!picture-686-944282.jpg"
    );
});

test("a search that matched nothing yields no art", () => {
    assert.strictEqual(artFromSearchResult("<Result></Result><NumberReturned>0</NumberReturned>"), null);
});

test("the folder image is tried after the advertised art", () => {
    assert.deepStrictEqual(
        artCandidates({ id: "http://10.0.0.30/Album/03.flac", art: "http://10.0.0.30/Album/01.flac/$!pict" }),
        [
            "http://10.0.0.30/Album/01.flac/$!pict",
            "http://10.0.0.30/Album/cover.jpg",
            "http://10.0.0.30/Album/folder.jpg",
        ]
    );
});

test("a track with no advertised art still gets the folder image", () => {
    assert.deepStrictEqual(artCandidates({ id: "http://10.0.0.30/Album/03.flac" }), [
        "http://10.0.0.30/Album/cover.jpg",
        "http://10.0.0.30/Album/folder.jpg",
    ]);
});

test("a track identified by title yields no folder to guess from", () => {
    // id falls back to the title when the renderer reports no TrackURI, and a title is
    // not a path - trimming its last segment would produce a URL for something else.
    assert.deepStrictEqual(artCandidates({ id: "Flight to LAPD" }), []);
    assert.deepStrictEqual(artCandidates({ id: "Flight to LAPD", art: "http://10.0.0.30/x.jpg" }), [
        "http://10.0.0.30/x.jpg",
    ]);
});

// Real device description, trimmed to the parts discovery reads. A renderer publishes
// several services and the one that matters is not first, and its control URL is
// relative to wherever the document was fetched from.
const LOCATION = "http://10.0.0.20:49152/description.xml";
const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<device>
<friendlyName>Living Room Streamer  A1B2</friendlyName>
<serviceList>
<service>
<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
<controlURL>/upnp/control/renderconnmgr1</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
<controlURL>/upnp/control/rendertransport1</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
<controlURL>/upnp/control/rendercontrol1</controlURL>
</service>
</serviceList>
</device>
</root>`;

test("picks the AVTransport service and resolves its control URL", () => {
    assert.deepStrictEqual(parseDescription(DESCRIPTION, LOCATION), {
        name: "Living Room Streamer  A1B2",
        control: "http://10.0.0.20:49152/upnp/control/rendertransport1",
    });
});

test("an absolute control URL is left alone", () => {
    const xml = DESCRIPTION.replace(
        "<controlURL>/upnp/control/rendertransport1</controlURL>",
        "<controlURL>http://10.0.0.99:8080/ctl</controlURL>"
    );
    assert.strictEqual(parseDescription(xml, LOCATION).control, "http://10.0.0.99:8080/ctl");
});

test("a device without AVTransport is not a renderer", () => {
    const xml = DESCRIPTION.replace("AVTransport", "ContentDirectory");
    assert.strictEqual(parseDescription(xml, LOCATION), null);
});

test("the same lookup finds a media server's ContentDirectory", () => {
    // The recovery path reuses discovery with a different service, so asking for
    // ContentDirectory must skip AVTransport rather than take the first service listed.
    const xml = DESCRIPTION.replace("AVTransport", "ContentDirectory");
    assert.strictEqual(
        parseDescription(xml, LOCATION, "ContentDirectory").control,
        "http://10.0.0.20:49152/upnp/control/rendertransport1"
    );
});

const RENDERERS = [
    { name: "Living Room Streamer  A1B2", control: "http://10.0.0.20/a" },
    { name: "Study DAC", control: "http://10.0.0.21/b" },
];

test("rendererName matches any part of the friendly name", () => {
    // The serial number in the full name is exactly what an owner would not type out,
    // so a prefix has to work - but pasting the whole listed name must work too.
    for (const wanted of ["Living Room Streamer  A1B2", "Living Room", "living", "  Study  "]) {
        assert.ok(matchRenderer(RENDERERS, wanted), wanted + " should match");
    }
    assert.strictEqual(matchRenderer(RENDERERS, "study").name, "Study DAC");
});

test("an empty rendererName takes the first renderer that answered", () => {
    assert.strictEqual(matchRenderer(RENDERERS, "").name, "Living Room Streamer  A1B2");
    assert.strictEqual(matchRenderer(RENDERERS, undefined).name, "Living Room Streamer  A1B2");
});

test("a name that matches nothing is not silently substituted", () => {
    assert.strictEqual(matchRenderer(RENDERERS, "Kitchen"), null);
    assert.strictEqual(matchRenderer([], "anything"), null);
});
