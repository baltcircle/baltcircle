import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("rider screens do not expose administrative query diagnostics", () => {
  const paths = [
    "pages/PaymentMethodsPage.tsx", "pages/SettingsPage.tsx", "pages/RentPage.tsx",
    "pages/RidesPage.tsx", "pages/SupportPage.tsx", "pages/MapPage.tsx",
    "components/DrawerMenu.tsx", "components/RentalStartModal.tsx",
    "components/SessionBoundary.tsx",
  ];
  it.each(paths)("%s uses a rider-specific notice", (path) => {
    const source = readFileSync(resolve(process.cwd(), "client/src", path), "utf8");
    expect(source.includes("RiderQueryErrorNotice")).toBe(true);
    expect(source.includes("<QueryErrorNotice")).toBe(false);
  });
});
