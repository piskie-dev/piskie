#!/bin/sh
set -eu

launcher_path=$0
launcher_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd)
launcher_name=$(basename -- "$launcher_path")
real_binary="$launcher_dir/${launcher_name}.bin"
launcher_script="$launcher_dir/resources/launcher/electron-launcher.mjs"

if [ ! -x "$real_binary" ]; then
  echo "[electron-launcher] Missing Electron binary: $real_binary" >&2
  exit 1
fi
if [ ! -f "$launcher_script" ]; then
  echo "[electron-launcher] Missing launcher script: $launcher_script" >&2
  exit 1
fi

export ELECTRON_RUN_AS_NODE=1
exec "$real_binary" "$launcher_script" --binary "$real_binary" -- "$@"
