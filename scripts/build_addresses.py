"""One address label per building/address, never a proximity-based cluster."""
import json
import sys
import unicodedata
from collections import defaultdict

from shapely import make_valid
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def coordinates(geometry):
    return [(p["lon"], p["lat"]) for p in geometry or [] if "lon" in p and "lat" in p]


def area_geometry(element):
    if element["type"] == "way":
        ring = coordinates(element.get("geometry"))
        if len(ring) >= 4 and ring[0] == ring[-1]:
            return make_valid(Polygon(ring))
    if element["type"] == "relation":
        # polygonize joins split outer/inner ways; holes are never buildings.
        rings = {"outer": [], "inner": []}
        for member in element.get("members", []):
            role = member.get("role") or "outer"
            if role == "outline":
                role = "outer"
            coords = coordinates(member.get("geometry"))
            if member["type"] == "way" and role in rings and len(coords) >= 2:
                rings[role].append(LineString(coords))
        outer = unary_union(list(polygonize(rings["outer"])))
        inner = unary_union(list(polygonize(rings["inner"])))
        if not outer.is_empty:
            return make_valid(outer.difference(inner))
    return None


def convert(data):
    if data.get("remark") or not data.get("elements"):
        raise ValueError("Incomplete or empty Overpass response; refusing to replace address tiles")
    elements = {(e["type"], e["id"]): e for e in data["elements"]}
    geometries = {}
    buildings = {}
    parent = {}
    for key, element in sorted(elements.items()):
        if element["type"] != "node":
            geometry = area_geometry(element)
            if geometry is not None and not geometry.is_empty and geometry.area > 0:
                geometries[key] = geometry
                if element.get("tags", {}).get("building") not in (None, "no"):
                    buildings[key] = geometry
                    if element["type"] == "relation":
                        for member in element.get("members", []):
                            if member["type"] == "way" and member.get("role", "") in ("", "outer", "outline", "part"):
                                parent[("way", member["ref"])] = key
    # Prefer a relation's complete footprint to its separately tagged members.
    for child, owner in parent.items():
        if child in buildings and buildings[owner].covers(buildings[child]):
            del buildings[child]
    keys = sorted(buildings)
    tree = STRtree([buildings[key] for key in keys])
    groups = defaultdict(list)
    for key, element in sorted(elements.items()):
        tags = element.get("tags", {})
        hn = str(tags.get("addr:housenumber") or "").strip()
        if not hn:
            continue
        geometry = geometries.get(key)
        if element["type"] == "node" and element.get("lon") is not None and element.get("lat") is not None:
            geometry = Point(element["lon"], element["lat"])
        if geometry is None and element["type"] == "way":
            coords = coordinates(element.get("geometry"))
            if len(coords) >= 2:
                geometry = LineString(coords)
        if geometry is None or geometry.is_empty:
            # Do not silently lose an address when an upstream geometry is broken.
            raise ValueError(f"Missing address geometry for {key}")
        point = geometry.representative_point()
        candidates = [keys[int(i)] for i in tree.query(geometry)
                      if buildings[keys[int(i)]].covers(geometry)]
        owner = min(candidates, key=lambda k: (buildings[k].area, k)) if candidates else None
        if key in buildings:
            owner = key
        elif key in parent and parent[key] in candidates:
            owner = parent[key]
        # No global street/number or distance dedup: separate homes may share both.
        group = (owner or key, normalized(hn))
        groups[group].append({
            "key": key, "hn": hn, "street": normalized(tags.get("addr:street") or tags.get("addr:place")),
            "point": point, "owner": owner,
            "priority": 0 if key == owner else 1 if key in geometries else 2,
        })
    address_groups_per_owner = defaultdict(int)
    for owner, _hn in groups:
        address_groups_per_owner[owner] += 1
    features = []
    for group, records in sorted(groups.items()):
        streets = {r["street"] for r in records if r["street"]}
        by_street = defaultdict(list)
        for record in records:
            street = record["street"]
            if not street and len(streets) == 1:
                street = next(iter(streets))
            by_street[street].append(record)
        for street, addresses in sorted(by_street.items()):
            chosen = min(addresses, key=lambda r: (r["priority"], r["key"]))
            point = chosen["point"]
            # For a single address in an unaddressed footprint, centre its one
            # remaining label inside the polygon instead of at a shop/entrance.
            if chosen["owner"] and len(by_street) == 1 and address_groups_per_owner[chosen["owner"]] == 1:
                point = buildings[chosen["owner"]].representative_point()
            owner = chosen["owner"] or chosen["key"]
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [point.x, point.y]},
                "properties": {"hn": chosen["hn"], "building_id": f"{owner[0]}/{owner[1]}",
                               "street": street},
            })
    if not features:
        raise ValueError("No usable addresses; refusing to publish empty tiles")
    return {"type": "FeatureCollection", "features": features}


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as source:
        result = convert(json.load(source))
    with open(sys.argv[2], "w", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, separators=(",", ":"))
    print(f"Consolidated address labels: {len(result['features'])}")
