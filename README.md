# Hi-Fi Discord Presence

Shows the track you are playing as Discord Rich Presence - title, artist, album, a live
progress bar and cover art - on your profile as a "Listening to" status.

One process monitors all three players. Start playback in any of them and the matching
Discord application is selected automatically:

| `source` | Reads from | Platforms |
| --- | --- | --- |
| `foobar2000` | foobar2000, through its Beefweb component | Windows |
| `roon` | Roon Core, as a Roon extension | Windows, macOS |
| `upnp` | Any UPnP renderer (streamer, network DAC), directly | Windows, macOS |

Each source has its own Discord Application ID, so its application name can say Roon,
foobar2000 or UPnP. A newly playing source takes over. Ordinary progress updates from
another player do not steal the status, and stopping the selected player falls back to
the most recently active player that is still playing.

## Prerequisites

- [Node.js 20 or later](https://nodejs.org/) - the installers fetch it for you, see below
- The Discord **desktop app** - the browser version has no IPC endpoint to connect to
- Whatever your enabled sources need (see below)

The installers each lean on one package manager, and that is the only thing you have to
bring yourself:

| | Needs | Comes with |
| --- | --- | --- |
| Windows | `winget` | Windows 11; Windows 10 1809 (build 17763) or later, once the Store has updated **App Installer** |
| macOS | [Homebrew](https://brew.sh/) | nothing - install it yourself |

Neither needs `git`, and neither needs Node.js already installed.

Older Windows, a machine with the Store locked down, or a Mac without Homebrew is not
shut out: the app itself has no such requirement. Install
[Node.js](https://nodejs.org/) by hand first and the installer carries on from there.
On Windows that is the whole difference - `cloudflared` is downloaded with `curl`, not
winget. On macOS you also lose the `cloudflared` install, so cover art needs a binary
placed next to `index.js` yourself (see [About cover art](#about-cover-art)).

## Setup

1. Use the included `config.json`, which has Discord Application IDs for Roon and
   foobar2000 already filled in. UPnP is disabled by default.
   If you prefer your own application IDs or want to enable UPnP, you can still create
   applications at <https://discord.com/developers/applications>. Give each one the
   player name you want Discord to show, then copy its **Application ID** from
   **General Information** into the matching `discordClientIds` entry.
   No OAuth, bot, client secret or verification setup is needed. These values are
   public application IDs, not API keys.
2. Let Discord show it: **Settings > Activity Privacy > Share your detected activities
   with others**. With this off everything still runs and logs normally, but nobody
   sees the status.
3. Install:
   - **Windows**: double-click `install.bat`. It installs Node.js through winget if
     missing, installs dependencies, downloads `cloudflared` for cover art, and
     registers the app to start every time you log in.
   - **macOS**: run `./install.sh`. Same thing, through Homebrew and a `launchd` agent.

   Neither needs anything preinstalled beyond winget or Homebrew, and neither needs
   `git`.

   Both keep the included `config.json`. If it is missing, they create it from
   `config.example.json` instead; fill in your Application IDs in that case.
4. Edit `config.json` if you need custom Application IDs or source settings.
   Leave an ID empty (or leave the placeholder unchanged) to
   disable that source. Then restart it:
   - **Windows**: run `install.bat` again.
   - **macOS**: `launchctl kickstart -k gui/$(id -u)/com.pcjustin.hifi-discord`

The included configuration looks like this:

```json
{
  "discordClientIds": {
    "foobar2000": "1540751155196592171",
    "roon": "1538482677466796092",
    "upnp": ""
  },
  "beefwebUrl": "http://127.0.0.1:8880",
  "rendererName": ""
}
```

The old single-source format (`source` plus `discordClientId`) is still accepted, so an
existing installation keeps working without migration.

## Per-source setup

### `foobar2000`

Reads playback over [Beefweb](https://github.com/hyperblast/beefweb), which exposes
foobar2000's state as a local HTTP API. Download
`foo_beefweb.fb2k-component` from its
[releases](https://github.com/hyperblast/beefweb/releases), double-click it, restart
foobar2000, then open **File > Preferences > Tools > Beefweb Remote Control** and make
sure it is enabled on port **8880**. Leave "allow remote connections" off - this app
only talks to your own machine.

`beefwebUrl` is only needed if you changed Beefweb's port.

### `roon`

Runs as a Roon extension. After starting it, open **Roon Settings > Extensions** and
enable **Hi-Fi Discord Presence** - until you do, Roon holds the registration open and
nothing appears.

Roon Server and this app must run on the same computer. The extension connects only
to the local Core (127.0.0.1), ignoring other Roon Servers on the LAN.

RoonLabs never published its SDK to npm, so those four packages are pinned to a commit
and fetched as plain tarballs from GitHub. That is deliberate: npm's `github:owner/repo`
shorthand resolves the ref with `git ls-remote` first, which would make `git` a
prerequisite on every machine that installs this.

The pairing is remembered in `roonstate.json` next to `index.js`.

### `upnp`

Reads the streamer (the UPnP renderer) directly, so the control point is irrelevant -
JPLAY, BubbleUPnP, mconnect, a NAS web UI or the streamer's own front panel all look
the same from here. Nothing is installed on the controller or the NAS, and the presence
keeps working after the controlling app is closed.

Ask the network which renderers are out there, since friendly names differ per device:

```sh
node index.js --list
```

`rendererName` is a case-insensitive substring of the friendly name, so a distinctive
word is enough. Leave it empty to take the first renderer that answers - all a
one-streamer network needs.

## About cover art

Discord fetches the Rich Presence image from a **public URL** - Discord's own servers
fetch it, not the viewer's client. Album art has no public URL: it is embedded in a
local file, held inside Roon, or sitting on a NAS at a LAN address. So this app caches
the bytes, serves them from a small local web server, and uses
[cloudflared](https://github.com/cloudflare/cloudflared) to open a free anonymous quick
tunnel that turns the local address into a `https://xxxx.trycloudflare.com` URL Discord
can reach. No Cloudflare account or domain is involved.

Everything except the artwork works without `cloudflared`. Any binary named
`cloudflared` (`cloudflared.exe` on Windows) next to `index.js` is used in preference to
one on the `PATH`, which is the easiest route on a machine without a package manager.

## The name Discord shows

The friends/member list's "Listening to ..." status shows the current track title
using Discord's `status_display_type` field. Tracks without a title show the album;
if both are missing, Discord uses the application name.

The application name in the expanded activity card still comes from the active
source's Discord application in the Developer Portal. To choose your own application
name, create your own application and use its ID in `config.json`, then rename it in
the portal.
The rename takes effect on Discord's side at once, but the
desktop client keeps serving the old one from cache until it is fully quit (⌘Q on macOS
- closing the window is not enough) and reopened.

## Notes

- Only one process instance runs at a time: a second one exits rather than fight the
  first over the presence. That one process can monitor all configured sources.
- Discord can show only one selected Rich Presence from this process. Starting or
  changing a track selects that source; pause/stop it before switching if more than one
  player is already running and you want the choice to be unambiguous.
- Position updates are not resent to Discord. It ticks the progress bar itself from the
  timestamps; only track changes and real seeks are pushed.
- Cover art can take a few seconds to appear after a restart. Discord fetches the URL
  through its own media proxy and caches it, and the quick tunnel hands out a fresh
  hostname on every run, so the first fetch of a run is always a cold one.
- Logs: `hifi-discord.log` next to `index.js` on Windows,
  `~/Library/Logs/hifi-discord.log` on macOS.

## Uninstall

`uninstall.bat` on Windows, `./uninstall.sh` on macOS. Both stop the app and remove the
autostart entry, leaving the folder and `config.json` alone.

On Windows, uninstall also stops orphaned copies of the installation's local
`cloudflared.exe` and checks that the identified processes have exited before reporting
success. It leaves the project directory before showing the final prompt, so that
window does not prevent you from deleting or replacing the folder.

When upgrading from a version with incomplete Windows cleanup, copy the updated
`uninstall.bat` and `stop-windows.js` into the existing installation and run that
uninstaller first. Keep a copy of `config.json` and `roonstate.json`, then install the
new version. If an older
`start.bat` was run inside an existing Command Prompt, close that window before
upgrading: while its old restart loop is sleeping, Windows does not expose the batch
file's path in the shell's command line. New launches use a dedicated supervisor that
can be identified even during the restart delay.

## Tests

```sh
npm test
```
