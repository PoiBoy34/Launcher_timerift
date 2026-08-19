#!/usr/bin/env bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/PoiBoy34/Launcher_timerift/main"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PACK_NAME="Time-Rift-Universe"
MC="1.20.1"
LOADER_VER="47.4.20"

SRC="$ROOT/modpacks/$PACK_NAME/mods"
OUT="$ROOT/packwiz/$PACK_NAME"

mkdir -p "$OUT"
cd "$OUT"

if [ ! -f pack.toml ]; then
  packwiz init --name "$PACK_NAME" --version "1.0.0" --author "PoiBoy34" \
    --mc-version "$MC" --modloader forge --forge-version "$LOADER_VER"
fi

rm -rf mods && mkdir -p mods

count=0
for jar in "$SRC"/*.jar; do
  [ -e "$jar" ] || continue
  base="$(basename "$jar")"
  slug="${base%.jar}"
  enc="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$base")"
  packwiz url add "$slug" "$REPO_RAW/modpacks/$PACK_NAME/mods/$enc" \
    --meta-folder mods > /dev/null
  count=$((count+1))
  echo "  + $base"
done

packwiz refresh
echo "==> $count mods référencés"

# --- Fichiers additionnels (servers.dat, configs par défaut) ---
if [ -f "$ROOT/modpacks/$PACK_NAME/servers.dat" ]; then
  cp "$ROOT/modpacks/$PACK_NAME/servers.dat" "$OUT/servers.dat"
  echo "  + servers.dat"
fi

packwiz refresh
