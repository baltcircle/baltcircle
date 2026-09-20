#!/usr/bin/env bash
# Build addresses-v2.pmtiles (one label per building/address).
# Called by .github/workflows/addresses-gen.yml on the self-hosted prod runner.
# Env: ADDR_BBOX (Overpass order S,W,N,E), CITY (label).
set -euo pipefail

ADDR_BBOX="${ADDR_BBOX:-54.60,19.85,55.00,20.70}"
CITY="${CITY:-Kaliningrad}"
OSM_DIR="/home/yc-user/osm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d "$OSM_DIR/.addresses-build.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

cd "$OSM_DIR"
echo "=== ADDRESS BUILD: $CITY bbox=$ADDR_BBOX ==="

# ── Ensure tippecanoe is available (built once, cached under osm/tippecanoe) ──
TIP="$OSM_DIR/tippecanoe/tippecanoe"
if [ ! -x "$TIP" ]; then
  echo "Building tippecanoe..."
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends git make g++ libsqlite3-dev zlib1g-dev
  rm -rf "$OSM_DIR/tippecanoe"
  git clone --depth 1 https://github.com/felt/tippecanoe.git "$OSM_DIR/tippecanoe"
  ( cd "$OSM_DIR/tippecanoe" && make -j"$(nproc)" )
fi
"$TIP" --version

# Full footprints let us merge shops/entrances with their building without
# hiding a neighbouring house that happens to have the same number.
IFS=',' read -r S W N E <<< "$ADDR_BBOX"
QUERY="[out:json][timeout:180];(nwr[\"addr:housenumber\"]($S,$W,$N,$E);way[\"building\"]($S,$W,$N,$E);rel[\"building\"]($S,$W,$N,$E););out geom;"

OK=""
for M in \
  "https://overpass.private.coffee/api/interpreter" \
  "https://overpass.kumi.systems/api/interpreter" \
  "https://overpass-api.de/api/interpreter"; do
  echo "Querying $M ..."
  if curl -fsS --max-time 240 -A "takeride-map/1.0" -G "$M" \
     --data-urlencode "data=$QUERY" -o "$WORK_DIR/addr.json" \
     && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("elements") and not d.get("remark") else 1)' "$WORK_DIR/addr.json"; then
    OK="$M"; break
  fi
  sleep 5
done
[ -n "$OK" ] || { echo "ERROR: all Overpass mirrors failed"; exit 1; }

# Keep geospatial dependencies isolated from the production host's Python.
# Tests run against the same runtime/library before any served file changes.
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$SCRIPT_DIR":/src:ro -v "$WORK_DIR":/data \
  -e PYTHONPATH=/tmp/deps -e PYTHONDONTWRITEBYTECODE=1 \
  python:3.12-slim sh -ec '
    pip install --quiet --disable-pip-version-check --no-cache-dir --target /tmp/deps -r /src/requirements-map.txt
    python -m unittest discover -s /src -p test_build_addresses.py
    python /src/build_addresses.py /data/addr.json /data/addr.geojson
  '

# ── Build pmtiles (z14-16; MapLibre overzooms past 16) ──
"$TIP" -o "$WORK_DIR/addresses-v2.pmtiles" \
  -l addresses -Z14 -z16 \
  --drop-densest-as-needed --no-tile-size-limit \
  "$WORK_DIR/addr.geojson"
test -s "$WORK_DIR/addresses-v2.pmtiles"
chmod 644 "$WORK_DIR/addresses-v2.pmtiles"

# ── Atomic swap into the served volume ──
# Same filesystem, so readers never observe a partially written archive.
# Leave the old URL intact for already-open clients and rollback.
mv -f "$WORK_DIR/addresses-v2.pmtiles" "$OSM_DIR/addresses-v2.pmtiles"
echo "=== DONE: $(du -sh "$OSM_DIR/addresses-v2.pmtiles") ==="
