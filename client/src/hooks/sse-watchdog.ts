// Pure staleness predicate for the active-ride SSE watchdog
// (use-active-ride-stream.tsx). Extracted into its own module — with no
// React/DOM/EventSource imports — so the actual decision logic is directly
// unit-testable without mocking the browser environment.
export function isStreamStale(lastActivityAt: number, now: number, thresholdMs: number): boolean {
  return now - lastActivityAt > thresholdMs;
}
