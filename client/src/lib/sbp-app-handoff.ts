export interface SbpViewportSnapshot {
  height: number;
  width: number;
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
  if (doc.visibilityState !== "visible"
    || Math.abs(win.innerWidth - snapshot.width) > 2
    || snapshot.height - win.innerHeight <= 4
    || Math.abs((win.visualViewport?.scale ?? 1) - 1) > 0.01
    || focused?.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
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
  return true;
}
