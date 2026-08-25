#!/bin/sh
# macOS: stop the app and remove its launchd agent.
cd "$(dirname "$0")"
LABEL="com.pcjustin.hifi-discord"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped $LABEL." || echo "$LABEL was not running."
if [ -f "$PLIST" ]; then
    rm "$PLIST"
    echo "Removed $PLIST"
else
    echo "No launch agent found - nothing to remove."
fi
echo "node_modules, config.json and this project folder were left untouched."
