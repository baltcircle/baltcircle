import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), "client/src/pages", path), "utf8");
describe("simplified admin forms", () => {
  it.each(["bikes/BikeFormDialog.tsx", "parkings/ParkingFormDialog.tsx", "maintenance/CreateTicketDialog.tsx"])(
    "centers and enlarges %s title", (path) => {
      const title = source(path).match(/<DialogTitle className="([^"]+)"/)?.[1];
      expect(title).toContain("text-xl");
      expect(title).toContain("text-center");
    },
  );
  it("removes bike edit helper", () => {
    expect(source("bikes/BikeFormDialog.tsx")).not.toContain("Измените поля и сохраните.");
  });
  it("removes parking notes without sending hidden notes back to the server", () => {
    const form = source("parkings/ParkingFormDialog.tsx");
    expect(form).not.toContain("Кликните по карте, чтобы выбрать точку.");
    expect(form).not.toContain("input-parking-notes");
    expect(form).not.toContain("notes: form.notes");
  });
  it("removes ticket title and allows submission without a description", () => {
    const form = source("maintenance/CreateTicketDialog.tsx");
    expect(form).not.toContain("input-ticket-title");
    expect(form).not.toContain("Создайте заявку на обслуживание велосипеда.");
    expect(form).toContain("Описание (необязательно)");
    expect(form).toContain("disabled={!form.bikeId.trim() || submitting}");
    expect(source("MaintenancePage.tsx")).not.toContain("title: form.title");
  });
});
