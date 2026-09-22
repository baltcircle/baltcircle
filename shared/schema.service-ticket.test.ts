import { describe, expect, it } from "vitest";
import { createTicketSchema } from "./schema";

describe("service ticket optional description", () => {
  it.each([undefined, "", "   "])("accepts missing or blank description: %s", (message) => {
    const result = createTicketSchema.parse({ bikeId: "BC-002", kind: "brakes", message });
    expect(result.message).toBe("");
    expect(result.title).toBeUndefined();
  });
  it("accepts and trims a short optional description", () => {
    expect(createTicketSchema.parse({ bikeId: "BC-002", message: " X " }).message).toBe("X");
  });
  it.each([null, 123, "x".repeat(2001)])("rejects invalid descriptions", (message) => {
    expect(createTicketSchema.safeParse({ bikeId: "BC-002", message }).success).toBe(false);
  });
  it("still requires a bike", () => {
    expect(createTicketSchema.safeParse({ bikeId: " " }).success).toBe(false);
  });
});
