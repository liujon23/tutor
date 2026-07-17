#!/bin/bash
# macOS double-clickable launcher: restarts the tutor server.
# Finder runs this in Terminal. To put it on your Desktop, drag this file there
# (hold Option to make a copy) or right-click -> Make Alias and move the alias.
cd "$(dirname "$0")" || exit 1
node scripts/restart.mjs
# Keep the window up if the server exits or errors, so you can read why.
echo
echo "Server stopped. Press any key to close this window."
read -n 1 -s
