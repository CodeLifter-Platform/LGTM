#!/bin/bash
# Generate macOS .icns from the iconset folder.
# Run this on a Mac before building: ./scripts/generate-icns.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$SCRIPT_DIR/../resources"

if [ ! -d "$RESOURCES/icon.iconset" ]; then
  echo "Error: resources/icon.iconset not found"
  exit 1
fi

iconutil -c icns "$RESOURCES/icon.iconset" -o "$RESOURCES/icon.icns"
echo "Created resources/icon.icns"
