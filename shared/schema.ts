import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/* ------- USERS (rider registration) ------- */
// Minimal rider identity captured at first rental. No sensitive payment data
// is ever stored here — only a display name and a contact phone. Phone is not
// ownership-verified yet (no SMS/OTP), so it is contact info, not auth.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),               // generated server-side
  name: text("name").notNull(),
  phone: text("phone").notNull(),            // normalized to digits with optional leading +
  createdAt: integer("created_at").notNull(),
});
export type User = typeof users.$inferSelect;

// Public-facing zod schema for the registration form. Validation messages are
// in Russian so they can surface directly in the UI.
export const registerUserSchema = z.object({
  name: z
    .string({ required_error: "Введите имя" })
    .trim()
    .min(2, "Имя должно содержать минимум 2 символа")
    .max(80, "Имя слишком длинное"),
  phone: z
    .string({ required_error: "Введите номер телефона" })
    .trim()
    .min(1, "Введите номер телефона"),
});
export type RegisterUserInput = z.infer<typeof registerUserSchema>;

/* ------- BIKES ------- */
export const bikes = sqliteTable("bikes", {
  id: text("id").primaryKey(),               // e.g. "BC-014"
  model: text("model").notNull(),            // Cruiser / Comfort / City+
  status: text("status").notNull(),          // available | rented | reserved | offline | maintenance
  battery: integer("battery").notNull(),     // 0-100 (smart lock battery)
  lat: real("lat").notNull(),                // map % space, see note below
  lng: real("lng").notNull(),
  lastSeen: integer("last_seen").notNull(),  // unix ms
  idleHours: real("idle_hours").notNull(),   // hours
  flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
});

export const insertBikeSchema = createInsertSchema(bikes);
export type InsertBike = z.infer<typeof insertBikeSchema>;
export type Bike = typeof bikes.$inferSelect;

/* ------- PARKING STATIONS ------- */
export const parkings = sqliteTable("parkings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  capacity: integer("capacity").notNull(),
  occupied: integer("occupied").notNull(),
});
export type Parking = typeof parkings.$inferSelect;

/* ------- ZONES (operating / restricted / forbidden) ------- */
/** zone.kind = "operating" | "slow" | "forbidden"
 *  polygon = JSON array of [x,y] map points
 */
export const zones = sqliteTable("zones", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  polygon: text("polygon").notNull(),
});
export type ZoneRow = typeof zones.$inferSelect;

/* ------- MAP OBJECTS (visual editor) ------- */
/** Operator-drawn routes & zones for the Yandex map.
 *  type   = "route" | "operating" | "slow" | "forbidden"
 *  kind   = "route" (polyline) | "zone" (polygon)
 *  points = JSON array of [lat, lng] coordinates
 */
export const mapObjects = sqliteTable("map_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  kind: text("kind").notNull(),
  color: text("color").notNull().default("#1d6f8e"),
  points: text("points").notNull(),
  createdAt: integer("created_at").notNull(),
});
export type MapObject = typeof mapObjects.$inferSelect;
export const insertMapObjectSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["route", "operating", "slow", "forbidden"]),
  kind: z.enum(["route", "zone"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1d6f8e"),
  points: z.array(z.tuple([z.number(), z.number()])).min(2),
});
export type InsertMapObject = z.infer<typeof insertMapObjectSchema>;

/* ------- RIDES ------- */
export const rides = sqliteTable("rides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bikeId: text("bike_id").notNull(),
  userId: text("user_id").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  startLat: real("start_lat").notNull(),
  startLng: real("start_lng").notNull(),
  endLat: real("end_lat"),
  endLng: real("end_lng"),
  track: text("track").notNull(),     // JSON: [[x,y,t], ...]
  distanceM: real("distance_m").notNull().default(0),
  cost: real("cost").notNull().default(0),
  tariff: text("tariff").notNull(),
  status: text("status").notNull(),   // active | completed | cancelled
});
export type Ride = typeof rides.$inferSelect;
export const insertRideSchema = createInsertSchema(rides);

/* ------- MAINTENANCE TICKETS ------- */
export const tickets = sqliteTable("tickets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bikeId: text("bike_id").notNull(),
  kind: text("kind").notNull(),       // low_battery | suspicious_idle | repair_request | out_of_zone
  message: text("message").notNull(),
  status: text("status").notNull(),   // open | in_progress | resolved
  createdAt: integer("created_at").notNull(),
});
export type Ticket = typeof tickets.$inferSelect;
export const insertTicketSchema = createInsertSchema(tickets).omit({ id: true, createdAt: true, status: true });

/* ------- PAYMENTS / BALANCE (single demo user) ------- */
export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  amount: real("amount").notNull(),
  kind: text("kind").notNull(),       // topup | ride_charge | tariff_purchase
  description: text("description").notNull(),
  createdAt: integer("created_at").notNull(),
});
export type Payment = typeof payments.$inferSelect;

export const wallet = sqliteTable("wallet", {
  userId: text("user_id").primaryKey(),
  balance: real("balance").notNull().default(0),
  activeTariff: text("active_tariff").notNull().default("payg"),
  tariffExpiresAt: integer("tariff_expires_at"),
});
export type Wallet = typeof wallet.$inferSelect;

/* ------- TYPES for API payloads ------- */
export type TariffId = "payg" | "day" | "month";
export interface TariffInfo {
  id: TariffId;
  name: string;
  price: number;
  unit: string;
  perMinute?: number;
  unlock?: number;
  freeMinutes?: number;
  description: string;
  popular?: boolean;
}
