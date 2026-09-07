// Viewport metrics for the map shell.
//
// Mobile WebKit reports transient, undersized viewport metrics while the app is
// being restored from the background (returning from a bank app opened through
// an SBP deeplink, from the share sheet, from the app switcher). A `resize`
// fires with those transient numbers and the settled one is not guaranteed to
// follow, so a naive "last value wins" mirror can leave the shell locked to a
// height that is shorter than the screen — the map then stops short of the
// bottom and the page background shows through.
//
// The screen height cannot shrink while the orientation stays the same, so we
// keep the largest height observed at the current width and drop the floor as
// soon as the width changes (rotation, desktop window resize).

export interface ViewportSample {
  screenHeight: number;
  innerHeight: number;
  visualHeight: number;
  clientHeight: number;
  width: number;
  /**
   * Whether the shrink guard applies. Only touch/system-managed viewports show
   * the transient-metrics problem; a desktop window genuinely does get shorter
   * when the user drags its bottom edge, and there the raw measurement is
   * always correct.
   */
  floorEligible: boolean;
}

export interface AppHeightState {
  width: number;
  height: number;
}

/** Largest height the current sample can justify, before the floor is applied. */
export function measureAppHeight(sample: ViewportSample): number {
  return Math.round(
    Math.max(sample.screenHeight, sample.innerHeight, sample.visualHeight, sample.clientHeight),
  );
}

export function nextAppHeight(
  prev: AppHeightState | null,
  sample: ViewportSample,
): AppHeightState | null {
  const measured = measureAppHeight(sample);
  // A zero/NaN sample means the document is not laid out yet (or the browser is
  // mid-restore). Keeping the previous value is strictly better than writing a
  // height that would collapse the shell.
  if (!Number.isFinite(measured) || measured <= 0) return prev;
  if (!prev || prev.width !== sample.width || !sample.floorEligible) {
    return { width: sample.width, height: measured };
  }
  return { width: sample.width, height: Math.max(prev.height, measured) };
}

export function readViewportSample(win: Window): ViewportSample {
  const vv = win.visualViewport;
  return {
    screenHeight: win.screen?.height ?? 0,
    innerHeight: win.innerHeight,
    visualHeight: vv?.height ?? 0,
    clientHeight: win.document.documentElement.clientHeight,
    width: Math.round(Math.max(win.screen?.width ?? 0, win.innerWidth, vv?.width ?? 0)),
    floorEligible: win.matchMedia?.("(pointer: coarse)").matches ?? false,
  };
}
