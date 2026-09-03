#!/bin/sh
# macOS: install dependencies and register a launchd agent that starts the app at login
# and restarts it if it dies.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
LABEL="com.pcjustin.hifi-discord"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/hifi-discord.log"

if ! command -v node >/dev/null 2>&1; then
    if ! command -v brew >/dev/null 2>&1; then
        echo "Node.js was not found, and Homebrew is not available to install it."
        echo "Install Node.js LTS from https://nodejs.org/ and re-run this script."
        exit 1
    fi
    # brew installs into a directory already on PATH, so unlike the Windows installer
    # this can carry straight on rather than asking for a second run. Only reached when
    # there is no node at all, so there is no version manager's copy to shadow.
    echo "Node.js was not found. Installing it now via Homebrew..."
    brew install node
    command -v node >/dev/null 2>&1 || {
        echo "Homebrew finished but node is still not on PATH. Open a new terminal and re-run this script."
        exit 1
    }
fi
# A version manager's shim carries the version in its path, so the agent would stop
# starting after an upgrade with no sign but a presence that never appears. Resolve it
# once here and write the real binary into the plist.
NODE="$(command -v node)"

[ -f config.json ] || {
    cp config.example.json config.json
    echo "Created config.json from the example. Open it and fill in \"discordClientIds\"."
}

echo "Installing npm dependencies..."
npm install

if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x ./cloudflared ]; then
    if command -v brew >/dev/null 2>&1; then
        echo "Installing cloudflared for cover art support..."
        brew install cloudflared || echo "WARNING: cloudflared install failed - everything works except cover art."
    else
        echo "WARNING: cloudflared not found and Homebrew is not available."
        echo "Everything works without it except cover art. Binaries:"
        echo "  https://github.com/cloudflare/cloudflared/releases"
    fi
fi

if grep -q YOUR_DISCORD_APPLICATION_ID config.json; then
    echo
    echo "NOTE: A placeholder Discord Application ID disables that source."
    echo "Make sure at least one entry in discordClientIds contains a real ID."
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$DIR/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLIST_EOF
# PATH is not decoration: agents start with a minimal one that excludes Homebrew, so
# without it cloudflared is never found and cover art quietly stops working.

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "Setup complete. It now starts automatically every time you log in."
echo "Log file: $LOG"
echo "After editing config.json:  launchctl kickstart -k gui/\$(id -u)/$LABEL"
