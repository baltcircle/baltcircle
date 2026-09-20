# Address labels

`scripts/build_addresses.py` consolidates OSM address objects within building
footprints. The previous extractor emitted a label for every object with
`addr:housenumber`, including every shop/cafe inside an already-addressed building.
The regression fixture covers the reported Pugacheva Street buildings: five 4А
objects and three 8А objects become one label per building.

## Rules

- Match by actual polygon containment, not distance or house number alone.
- Keep separate buildings, distinct numbers and explicitly different streets.
- Prefer the building address over POIs. An unspecified street is merged only
  when the building/number group has a single known street.
- Support multipolygon holes, split rings and building-relation outlines.
- Keep standalone addresses and open address ways.
- Reject incomplete Overpass responses, missing address geometry and empty output.
- Use Shapely 2.1.2 in an isolated Python 3.12 container; no system Python changes.

## Publication

Run `Generate Address Tiles` against the verified main commit before approving
the application deployment. The workflow downloads full building geometry, runs
the converter tests, builds z14–16 tiles and atomically publishes
`/home/yc-user/osm/addresses-v2.pmtiles`. The app deployment checks that this
archive exists before restarting.

The versioned URL avoids the old archive's 24-hour browser cache. The legacy
`addresses.pmtiles` is intentionally retained for old clients and rollback.
Temporary files live on the target filesystem and are removed on failure.

Tests:

```sh
pip install -r scripts/requirements-map.txt
python -m unittest discover -s scripts -p test_build_addresses.py
```
