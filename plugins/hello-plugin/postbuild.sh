#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NAME=hello-plugin
rm -rf "$ROOT/dist/plugins/$NAME"
mkdir -p "$ROOT/dist/plugins/$NAME"
cp -R "$ROOT/plugins/$NAME/dist" "$ROOT/dist/plugins/$NAME/dist"
cp "$ROOT/plugins/$NAME/package.json" "$ROOT/dist/plugins/$NAME/package.json"
cp "$ROOT/plugins/$NAME/openclaw.plugin.json" "$ROOT/dist/plugins/$NAME/openclaw.plugin.json"
