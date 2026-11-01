#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION=${1:-"0.2.1"}
mkdir -p dist

echo "========================================="
echo "  p2p-social: Packaging Silent OTA Bundle"
echo "========================================="
echo "OTA Version: v$VERSION"

cat <<EOF > ui/manifest.json
{
  "version": "$VERSION",
  "buildTime": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gitCommit": "$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')",
  "type": "ota-update"
}
EOF

OTA_NAME="ota-bundle-v$VERSION.zip"
OTA_PATH="dist/$OTA_NAME"
LATEST_OTA_PATH="dist/ota-bundle.zip"

rm -f "$OTA_PATH" "$LATEST_OTA_PATH"

zip -q -r "$OTA_PATH" ui backend/index.js -x "*.DS_Store" -x "*~"
cp "$OTA_PATH" "$LATEST_OTA_PATH"

echo "========================================="
echo " OTA BUNDLE READY!"
echo " Location: $DIR/$OTA_PATH"
echo " Generic:  $DIR/$LATEST_OTA_PATH"
echo " Size:     $(du -h "$OTA_PATH" | cut -f1)"
echo "========================================="
