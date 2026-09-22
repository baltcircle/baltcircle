import { forwardRef, type ReactNode } from "react";

/**
 * WebKit can restore an undersized fixed-position viewport after a bank
 * deeplink. Keep the page surface at the guarded map-shell height, but size
 * interactive content to the visual viewport (browser bars / keyboard).
 * This prevents the map or water backdrop showing below customer pages.
 */
export const CustomerOverlayViewport = forwardRef<HTMLDivElement, {
  children: ReactNode;
  className?: string;
}>(function CustomerOverlayViewport({ children, className = "" }, ref) {
  return (
    <div
      ref={ref}
      data-testid="customer-overlay-viewport"
      className={`fixed inset-x-0 top-0 z-50 h-screen bg-background ${className}`}
      style={{ height: "max(100dvh, var(--app-height, 100dvh))" }}
    >
      <div
        data-testid="customer-overlay-content"
        className="min-h-0 overflow-hidden"
        style={{
          height: "var(--visible-height, 100dvh)",
          marginTop: "var(--visible-top, 0px)",
        }}
      >
        {children}
      </div>
    </div>
  );
});
