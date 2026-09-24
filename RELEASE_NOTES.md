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
