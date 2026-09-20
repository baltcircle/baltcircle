import json
from pathlib import Path
import unittest

from build_addresses import convert


def building(id, x=0, hn="4А", street="Первая", width=1):
    tags = {"building": "yes"}
    if hn:
        tags.update({"addr:housenumber": hn, "addr:street": street})
    return {"type": "way", "id": id, "tags": tags, "geometry": [
        {"lon": a, "lat": b} for a, b in [(x, 0), (x+width, 0), (x+width, 1), (x, 1), (x, 0)]
    ]}


def node(id, x, y, hn="4А", street="Первая"):
    return {"type": "node", "id": id, "lon": x, "lat": y,
            "tags": {"addr:housenumber": hn, "addr:street": street, "shop": "yes"}}


def features(*elements):
    return convert({"elements": list(elements)})["features"]


class AddressTests(unittest.TestCase):
    def test_actual_pugacheva_buildings_have_one_label_each(self):
        data = json.loads((Path(__file__).parent / "fixtures/address-duplicates.json").read_text())
        self.assertEqual(len(data["elements"]), 8)
        result = convert(data)["features"]
        self.assertEqual(sorted(f["properties"]["hn"] for f in result), ["4А", "8А"])

    def test_shop_entrance_and_building_merge_including_boundary(self):
        self.assertEqual(len(features(building(1), node(2, .3, .5), node(3, 0, .5))), 1)

    def test_distinct_buildings_with_same_number_remain(self):
        self.assertEqual(len(features(building(1), building(2, x=2), node(3, .5, .5))), 2)

    def test_standalone_address_is_not_removed_by_number_or_distance(self):
        self.assertEqual(len(features(building(1), node(2, 1.00001, .5))), 2)

    def test_open_address_way_is_preserved(self):
        way = building(1)
        del way["tags"]["building"]
        way["geometry"] = way["geometry"][:3]
        self.assertEqual(len(features(way)), 1)

    def test_distinct_numbers_and_streets_in_same_building_remain(self):
        result = features(building(1), node(2, .4, .5, hn="4Б"),
                          node(3, .7, .5, street="Вторая"))
        self.assertEqual(len(result), 3)
        self.assertEqual(len({tuple(f["geometry"]["coordinates"]) for f in result}), 3)

    def test_unaddressed_building_can_consolidate_poi_addresses(self):
        self.assertEqual(len(features(building(1, hn=None), node(2, .3, .5),
                                      node(3, .7, .5, street=""))), 1)

    def test_missing_street_does_not_merge_two_known_streets(self):
        self.assertEqual(len(features(building(1), node(2, .3, .5, street="Вторая"),
                                      node(3, .7, .5, street=""))), 3)

    def test_case_and_whitespace_normalize_without_losing_original_label(self):
        result = features(building(1), node(2, .3, .5, hn=" 4а ", street=" первая "))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["properties"]["hn"], "4А")

    def test_relation_hole_is_not_part_of_building(self):
        outer = building(1, width=4)["geometry"]
        hole = [{"lon": x, "lat": y} for x, y in [(1,.2),(2,.2),(2,.8),(1,.8),(1,.2)]]
        relation = {"type": "relation", "id": 10, "tags": {"building": "yes", "addr:housenumber": "4А"},
                    "members": [{"type": "way", "ref": 1, "role": "outer", "geometry": outer},
                                {"type": "way", "ref": 2, "role": "inner", "geometry": hole}]}
        self.assertEqual(len(features(relation, node(3,.5,.5,street=""), node(4,1.5,.5,street=""))), 2)

    def test_relation_member_and_poi_do_not_duplicate_parent(self):
        way = building(1)
        relation = {"type": "relation", "id": 10, "tags": way["tags"],
                    "members": [{"type": "way", "ref": 1, "role": "outer", "geometry": way["geometry"]}]}
        self.assertEqual(len(features(way, relation, node(3,.5,.5))), 1)

    def test_building_relation_outline_is_supported(self):
        way = building(1)
        relation = {"type": "relation", "id": 10, "tags": {**way["tags"], "type": "building"},
                    "members": [{"type": "way", "ref": 1, "role": "outline", "geometry": way["geometry"]}]}
        self.assertEqual(len(features(way, relation, node(3,.5,.5))), 1)

    def test_repeated_input_and_order_are_deterministic(self):
        b, n = building(1), node(2,.5,.5)
        self.assertEqual(features(b, n, n), features(n, b))

    def test_incomplete_overpass_response_fails_closed(self):
        for data in [{"remark": "runtime error", "elements": [building(1)]}, {}, {"elements": []}]:
            with self.assertRaises(ValueError):
                convert(data)


if __name__ == "__main__":
    unittest.main()
