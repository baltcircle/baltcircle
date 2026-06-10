// Smoke test for the parking-marker rendering contract.
//
// This guards the regression behind "inactive parking still not visible on the
// admin map": inactive parkings were styled with a parking preset
// (islands#blueParkingIcon) that ships a fixed-colour image and ignores
// `iconColor`, so they rendered identical to active points and looked missing.
//
// The fix is that inactive markers use a *colorable* preset and a readable
// opacity. These assertions lock that in without needing a map/DOM runtime.
//
// Run with:  npx tsx script/smoke-parking-marker.ts
import {
  parkingPlacemarkStyle,
  FIXED_COLOR_PRESETS,
  PARKING_INACTIVE,
} from "../shared/parkingMarker.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

const active = parkingPlacemarkStyle(false);
const inactive = parkingPlacemarkStyle(true);

assert(active.preset === "islands#blueParkingIcon", "active parking uses the blue parking glyph");
assert(active.opacity === 1, "active parking is fully opaque");
assert(active.zIndex > inactive.zIndex, "active markers sit above inactive ones");

assert(
  !FIXED_COLOR_PRESETS.includes(inactive.preset),
  "inactive parking avoids fixed-colour presets that ignore iconColor",
);
assert(inactive.iconColor === PARKING_INACTIVE, "inactive parking is coloured muted grey");
assert(
  inactive.opacity >= 0.55,
  `inactive parking opacity stays readable (>=0.55), got ${inactive.opacity}`,
);
assert(inactive.preset !== active.preset, "inactive and active presets differ so the two are distinguishable");

console.log("\nAll parking marker contract checks passed.");
