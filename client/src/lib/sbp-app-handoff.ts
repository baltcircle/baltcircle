export interface SbpViewportSnapshot {
  height: number;
  width: number;
}

export interface SbpViewportRecovery extends SbpViewportSnapshot {
  attempts: number;
  nextAttemptAt: number;
  until: number;
}

const MAX_RECOVERY_ATTEMPTS = 4;
const RECOVERY_INTERVAL_MS = 150;
const RECOVERY_WINDOW_MS = 2000;

export function createSbpViewportRecovery(
  snapshot: SbpViewportSnapshot, now = Date.now(),
): SbpViewportRecovery {
  return { ...snapshot, attempts: 0, nextAttemptAt: now, until: now + RECOVERY_WINDOW_MS };
}

function viewportInteractionBusy(win: Window): boolean {
  return win.document.visibilityState !== "visible"
    || Math.abs((win.visualViewport?.scale ?? 1) - 1) > 0.01
    || !!(win.document.activeElement as HTMLElement | null)
      ?.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

/** Returns true when recovery is complete or its bounded retry budget is exhausted. */
export function continueSbpViewportRecovery(
  recovery: SbpViewportRecovery, win: Window = window, now = Date.now(),
): boolean {
  if (now >= recovery.until
    || recovery.attempts >= MAX_RECOVERY_ATTEMPTS
    || Math.abs(win.innerWidth - recovery.width) > 2
    || recovery.height - win.innerHeight <= 4) return true;
  if (now < recovery.nextAttemptAt || viewportInteractionBusy(win)) return false;

  // Set the guard before reflow/focus: these can synchronously emit resize events.
  recovery.attempts++;
  recovery.nextAttemptAt = now + RECOVERY_INTERVAL_MS;
  return repairSbpViewport(recovery, win) || recovery.attempts >= MAX_RECOVERY_ATTEMPTS;
}

let pending: (SbpViewportSnapshot & { at: number; hidden: boolean }) | null = null;

/** No bank URLs, payment identifiers or persistent storage are involved. */
export function markSbpAppHandoff(win: Window = window) {
  pending = {
    height: Math.max(win.innerHeight, win.document.documentElement.clientHeight),
    width: win.innerWidth,
    at: Date.now(),
    hidden: false,
  };
  // Close bank-search keyboard before handing control to a native app.
  (win.document.activeElement as HTMLElement | null)?.blur?.();
}

export function noteSbpAppHidden() {
  if (pending) pending.hidden = true;
}

export function consumeSbpAppHandoff(): SbpViewportSnapshot | null {
  if (!pending) return null;
  if (Date.now() - pending.at > 30 * 60_000) {
    pending = null;
    return null;
  }
  if (!pending.hidden) return null;
  const snapshot = { height: pending.height, width: pending.width };
  pending = null;
  return snapshot;
}

/**
 * CSS extension cannot repair WebKit's own shrunken canvas. A synchronous
 * display/layout cycle of the full-height view asks WebKit to measure it
 * again, without navigation, React remounts or a frame painted while hidden.
 * Only use after an actual SBP background/foreground transition.
 */
export function repairSbpViewport(snapshot: SbpViewportSnapshot, win: Window = window): boolean {
  const doc = win.document;
  const focused = doc.activeElement as HTMLElement | null;
  if (viewportInteractionBusy(win)
    || Math.abs(win.innerWidth - snapshot.width) > 2
    || snapshot.height - win.innerHeight <= 4) {
    return false;
  }
  const frame = doc.querySelector<HTMLElement>('[data-testid="customer-overlay-viewport"]');
  if (!frame) return false;
  const scroll = [frame, ...Array.from(frame.querySelectorAll<HTMLElement>("*"))]
    .filter((el) => el.scrollTop || el.scrollLeft)
    .map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft }));
  const display = frame.style.getPropertyValue("display");
  const priority = frame.style.getPropertyPriority("display");
  try {
    frame.style.setProperty("display", "none", "important");
    void frame.offsetHeight;
  } finally {
    if (display) frame.style.setProperty("display", display, priority);
    else frame.style.removeProperty("display");
    void frame.offsetHeight;
    focused?.focus?.({ preventScroll: true });
    for (const { el, top, left } of scroll) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
  // A first reflow can restore only part of the missing height on iOS.
  return snapshot.height - win.innerHeight <= 4;
}
