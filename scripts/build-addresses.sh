#!/usr/bin/env bash
# Build addresses.pmtiles (OSM house numbers) into /home/yc-user/osm.
# Called by .github/workflows/addresses-gen.yml on the self-hosted prod runner.
# Env: ADDR_BBOX (Overpass order S,W,N,E), CITY (label).
set -euo pipefail

ADDR_BBOX="${ADDR_BBOX:-54.60,19.85,55.00,20.70}"
CITY="${CITY:-Kaliningrad}"
OSM_DIR="/home/yc-user/osm"

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

# ── Fetch addr:housenumber (nodes + way centroids) from Overpass ──
IFS=',' read -r S W N E <<< "$ADDR_BBOX"
QUERY="[out:json][timeout:180];(node[\"addr:housenumber\"]($S,$W,$N,$E);way[\"addr:housenumber\"]($S,$W,$N,$E););out center tags;"

OK=""
for M in \
  "https://overpass-api.de/api/interpreter" \
  "https://overpass.kumi.systems/api/interpreter" \
  "https://overpass.private.coffee/api/interpreter"; do
  echo "Querying $M ..."
  if curl -sf -A "takeride-map/1.0" -X POST "$M" --data-urlencode "data=$QUERY" -o /tmp/addr.json \
     && head -c 1 /tmp/addr.json | grep -q '{'; then
    OK="$M"; break
  fi
  sleep 5
done
[ -n "$OK" ] || { echo "ERROR: all Overpass mirrors failed"; exit 1; }

# ── Convert to GeoJSON (points with `hn` property) ──
python3 - /tmp/addr.json /tmp/addr.geojson <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
feats = []
for e in d["elements"]:
    hn = e.get("tags", {}).get("addr:housenumber")
    if not hn:
        continue
    if e["type"] == "node":
        lon, lat = e.get("lon"), e.get("lat")
    else:
        c = e.get("center", {}); lon, lat = c.get("lon"), c.get("lat")
    if lon is None or lat is None:
        continue
    feats.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": {"hn": hn},
    })
json.dump({"type": "FeatureCollection", "features": feats}, open(dst, "w"), ensure_ascii=False)
print("address features:", len(feats))
PY

# ── Build pmtiles (z14-16; MapLibre overzooms past 16) ──
"$TIP" -o /tmp/addresses.pmtiles \
  -l addresses -Z14 -z16 \
  --drop-densest-as-needed --no-tile-size-limit --force \
  /tmp/addr.geojson
ls -la /tmp/addresses.pmtiles

# ── Atomic swap into the served volume ──
mv -f /tmp/addresses.pmtiles "$OSM_DIR/addresses.pmtiles"
echo "=== DONE: $(du -sh "$OSM_DIR/addresses.pmtiles") ==="
