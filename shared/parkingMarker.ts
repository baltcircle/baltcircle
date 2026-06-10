// Placemark styling contract for parking markers on the Yandex map.
//
// Kept React/DOM-free in shared/ so the active vs inactive rendering decision
// can be unit-tested without a map runtime — and so the rule that broke this
// feature is locked in:
//
//   Inactive parkings MUST use a *colorable* preset. The parking presets
//   (islands#blueParkingIcon) carry a fixed-colour image and silently ignore
//   `iconColor`, so an inactive point styled that way renders identical to an
//   active one and looks "missing" on the admin maps.

// Resolved sea brand colour (Yandex overlays can't read CSS variables).
export const PARKING_SEA = "#1d6f8e";
export const PARKING_INACTIVE = "#8a8f96";

export interface ParkingMarkerStyle {
  preset: string;
  iconColor: string;
  zIndex: number;
  /** Never below ~0.55, so inactive markers stay readable, not "hidden". */
  opacity: number;
}

export function parkingPlacemarkStyle(inactive: boolean): ParkingMarkerStyle {
  return inactive
    ? { preset: "islands#grayStretchyIcon", iconColor: PARKING_INACTIVE, zIndex: 150, opacity: 0.7 }
    : { preset: "islands#blueParkingIcon", iconColor: PARKING_SEA, zIndex: 200, opacity: 1 };
}

/** Presets that ship a fixed-colour image and ignore `iconColor`. An inactive
 *  parking must never use one of these, or its grey muting is lost. */
export const FIXED_COLOR_PRESETS = [
  "islands#blueParkingIcon",
  "islands#redParkingIcon",
  "islands#greenParkingIcon",
  "islands#nightParkingIcon",
];
