#!/usr/bin/env bash
# Ad-hoc sign the local Electron.app after npm installs it.
#
# The published electron zip extracts without a bundle code signature. On Apple
# Silicon macOS kills the unsigned binary with SIGKILL and removes the bundle,
# so `electron .` fails with a missing app on the next run. Re-signing with an
# ad-hoc identity makes the local development binary launchable again.
#
# Packaging signs the app separately via electron-forge, so this only affects
# the development binary in node_modules.
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || exit 0

app_dir="$(node -p "require('path').dirname(require.resolve('electron/package.json'))" 2>/dev/null)/dist/Electron.app"

if [ ! -d "$app_dir" ]; then
  echo "sign-electron: $app_dir not found, skipping" >&2
  exit 0
fi

if codesign --verify "$app_dir" >/dev/null 2>&1; then
  exit 0
fi

codesign --force --deep --sign - "$app_dir"
