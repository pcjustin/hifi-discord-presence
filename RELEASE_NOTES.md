# Hi-Fi Discord Presence 1.0.5

## What's changed

- Fixed installation failing with `EALLOWREMOTE` on npm 12, which blocks URL dependencies by default. The project now ships an `.npmrc` that allows the Roon packages declared in `package.json`.
- Updated the Roon extension and YouTube Chrome extension versions to `1.0.5`.

# Hi-Fi Discord Presence 1.0.4

## What's changed

- Windows and macOS installers now install or update Node.js on every run, so existing installations receive current security updates.
- Updated the Roon extension and YouTube Chrome extension versions to `1.0.4`.

# Hi-Fi Discord Presence 1.0.3

## What's changed

- Standardized the Discord activity fields: the track title appears in **Details**, the
  album appears in **State**, and the artist appears when hovering over the cover art
  when available.
- UPnP uses the first `upnp:artist` value for the cover-art hover text, with
  `dc:creator` as a fallback.
- Fixed UPnP updates for tracks without a title. Details are omitted so Discord does
  not keep showing the previous track's title.
- Updated the Roon extension and YouTube Chrome extension versions to `1.0.3`.

