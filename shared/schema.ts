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
  email: text("email"),                      // optional, rider-supplied; validated on update
  role: text("role").notNull().default("rider"), // rider | operator | admin
  consentAcceptedAt: integer("consent_accepted_at"), // unix ms when consent was accepted
  consentVersion: text("consent_version"),   // e.g. "v1-2026-06-07"
  consentIp: text("consent_ip"),             // best-effort client IP captured at consent time
  blockedAt: integer("blocked_at"),          // unix ms when an operator blocked the account; null = active
  blockedReason: text("blocked_reason"),     // optional operator-supplied note shown in the admin UI
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),          // unix ms of last profile mutation
});
export type User = typeof users.$inferSelect;
export type UserRole = "rider" | "operator" | "admin";

// Admin role assignment. Restricted to the three known roles so an operator
// can't store an arbitrary string. Promotion to "admin" is gated server-side
// (only an admin may grant admin) — this schema just validates the value.
export const adminSetRoleSchema = z.object({
  role: z.enum(["rider", "operator", "admin"]),
});
export type AdminSetRoleInput = z.infer<typeof adminSetRoleSchema>;

// Admin block/unblock. `blocked: true` disables the account; an optional reason
// is stored for the audit trail and shown back in the admin table.
export const adminSetBlockedSchema = z.object({
  blocked: z.boolean(),
  reason: z
    .union([z.string().trim().max(200), z.literal("")])
    .optional(),
});
export type AdminSetBlockedInput = z.infer<typeof adminSetBlockedSchema>;

// Consent terms version currently in force. Bump (and update the privacy/consent
// copy) whenever the terms change so we can tell who accepted which version.
export const CONSENT_VERSION = "v1-2026-06-07";

// Profile self-service update: a rider may change their display name and email.
// Phone is intentionally excluded here — changing it must go through SMS OTP.
export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Имя должно содержать минимум 2 символа")
    .max(80, "Имя слишком длинное")
    .optional(),
  email: z
    .union([z.string().trim().email("Введите корректный email").max(120), z.literal("")])
    .optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/* ------- OTP REQUESTS (SMS phone verification) ------- */
// One pending verification per phone. The code is never stored in plaintext —
// only an HMAC of the code is kept server-side. A row is created/replaced when
// a rider asks for a code and consumed once verification succeeds.
export const otpRequests = sqliteTable("otp_requests", {
  phone: text("phone").primaryKey(),         // normalized +7… form
  name: text("name").notNull(),              // carried through to user creation
  codeHash: text("code_hash").notNull(),     // HMAC-SHA256 of the OTP, never plaintext
  expiresAt: integer("expires_at").notNull(),// unix ms — code invalid after this
  attempts: integer("attempts").notNull().default(0),     // wrong-code tries used
  lastSentAt: integer("last_sent_at").notNull(),          // unix ms of last SMS, for resend lock
  consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
});
export type OtpRequest = typeof otpRequests.$inferSelect;

// Step 1: request a code. Consent must be accepted before any SMS is sent.
export const otpStartSchema = z.object({
  name: z
    .string({ required_error: "Введите имя" })
    .trim()
    .min(2, "Имя должно содержать минимум 2 символа")
    .max(80, "Имя слишком длинное"),
  phone: z
    .string({ required_error: "Введите номер телефона" })
    .trim()
    .min(1, "Введите номер телефона"),
  consent: z.literal(true, {
    errorMap: () => ({ message: "Необходимо согласие на обработку персональных данных" }),
  }),
});
export type OtpStartInput = z.infer<typeof otpStartSchema>;

// Step 2: verify the code the rider received by SMS.
export const otpVerifySchema = z.object({
  phone: z.string({ required_error: "Введите номер телефона" }).trim().min(1),
  code: z
    .string({ required_error: "Введите код из SMS" })
    .trim()
    .regex(/^\d{4}$/, "Код состоит из 4 цифр"),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

/* ------- PHONE CHANGE (SMS OTP for an existing account) ------- */
// A logged-in rider changing their phone. Verification mirrors registration
// OTP but is keyed by the user id (not the phone) and carries the *new* phone
// through to the update. Only the HMAC of the code is stored. A row is
// created/replaced when the rider requests a code and consumed on success.
export const phoneChangeRequests = sqliteTable("phone_change_requests", {
  userId: text("user_id").primaryKey(),      // the rider changing their number
  newPhone: text("new_phone").notNull(),     // normalized +7… target number
  codeHash: text("code_hash").notNull(),     // HMAC-SHA256 of the OTP, never plaintext
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastSentAt: integer("last_sent_at").notNull(),
  consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
});
export type PhoneChangeRequest = typeof phoneChangeRequests.$inferSelect;

// Step 1: request a code sent to the new number.
export const phoneChangeStartSchema = z.object({
  phone: z
    .string({ required_error: "Введите номер телефона" })
    .trim()
    .min(1, "Введите номер телефона"),
});
export type PhoneChangeStartInput = z.infer<typeof phoneChangeStartSchema>;

// Step 2: verify the code sent to the new number.
export const phoneChangeVerifySchema = z.object({
  code: z
    .string({ required_error: "Введите код из SMS" })
    .trim()
    .regex(/^\d{4}$/, "Код состоит из 4 цифр"),
});
export type PhoneChangeVerifyInput = z.infer<typeof phoneChangeVerifySchema>;

/* ------- BIKES ------- */
export const bikes = sqliteTable("bikes", {
  id: text("id").primaryKey(),               // e.g. "BC-014"
  model: text("model").notNull(),            // Cruiser / Comfort / City+
  status: text("status").notNull(),          // see BIKE_STATUSES below
  battery: integer("battery").notNull(),     // 0-100 (smart lock battery)
  lat: real("lat").notNull(),                // map % space, see note below
  lng: real("lng").notNull(),
  lastSeen: integer("last_seen").notNull(),  // unix ms
  idleHours: real("idle_hours").notNull(),   // hours
  flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
  // ----- Real-fleet operations fields (added for admin management) -----
  serial: text("serial"),                    // manufacturer serial / frame number
  lockId: text("lock_id"),                   // smart-lock id placeholder (no real integration yet)
  parkingId: text("parking_id"),             // optional home parking station id
  notes: text("notes"),                      // operator free-text notes
  // `seed` marks demo fleet rows so the demo reseed migration can refresh them
  // without ever touching bikes an operator added manually.
  seed: integer("seed", { mode: "boolean" }).notNull().default(false),
});

// Operational statuses. `available`/`rented`/`reserved` drive the rental flow;
// `maintenance`/`offline`/`storage`/`lost` take a bike out of rotation; and
// `archived` hides a retired bike from the public list (soft delete).
export const BIKE_STATUSES = [
  "available", "rented", "reserved", "maintenance", "offline", "storage", "lost", "archived",
] as const;
export type BikeStatus = (typeof BIKE_STATUSES)[number];

// Statuses a bike must NOT be in to be rentable from the public app/map.
export const RENTABLE_STATUSES: readonly BikeStatus[] = ["available", "reserved"];

export const insertBikeSchema = createInsertSchema(bikes);
export type InsertBike = z.infer<typeof insertBikeSchema>;
export type Bike = typeof bikes.$inferSelect;

// Admin: create a bike. Id/model required; status defaults to available. Map
// coordinates are optional (default to a station/centre server-side). Battery
// defaults to 100 for a freshly provisioned lock.
const bikeIdRegex = /^[A-Za-z0-9-]{2,20}$/;
export const adminCreateBikeSchema = z.object({
  id: z.string().trim().regex(bikeIdRegex, "Код: латиница, цифры и дефис (2–20 символов)"),
  model: z.string().trim().min(1, "Укажите модель").max(60),
  status: z.enum(BIKE_STATUSES).default("available"),
  battery: z.number().int().min(0).max(100).default(100),
  serial: z.union([z.string().trim().max(60), z.literal("")]).optional(),
  lockId: z.union([z.string().trim().max(60), z.literal("")]).optional(),
  parkingId: z.union([z.string().trim().max(40), z.literal("")]).optional(),
  notes: z.union([z.string().trim().max(500), z.literal("")]).optional(),
});
export type AdminCreateBikeInput = z.infer<typeof adminCreateBikeSchema>;

// Admin: edit a bike. All fields optional; id is immutable (path param).
export const adminUpdateBikeSchema = z.object({
  model: z.string().trim().min(1).max(60).optional(),
  status: z.enum(BIKE_STATUSES).optional(),
  battery: z.number().int().min(0).max(100).optional(),
  serial: z.union([z.string().trim().max(60), z.literal("")]).optional(),
  lockId: z.union([z.string().trim().max(60), z.literal("")]).optional(),
  parkingId: z.union([z.string().trim().max(40), z.literal("")]).optional(),
  notes: z.union([z.string().trim().max(500), z.literal("")]).optional(),
});
export type AdminUpdateBikeInput = z.infer<typeof adminUpdateBikeSchema>;

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

// A ride enriched with the rider's display name/phone for the admin rides
// table. Identity is resolved server-side from the users table; an unknown or
// demo rider yields null name/phone so the UI can fall back to the raw id.
export type AdminRide = Ride & {
  userName: string | null;
  userPhone: string | null;
};

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

/* ------- PAYMENT METHODS (MVP placeholders, no card data) ------- */
// A rider's linked payment methods. Strictly metadata: we record the *kind*
// (card / sbp), a human label (e.g. masked test pan), and a status — never a
// real card number, CVC, or token. No real acquiring is performed.
export const paymentMethods = sqliteTable("payment_methods", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),              // card | sbp
  label: text("label").notNull(),            // display label, e.g. "•••• 4242" / "СБП"
  status: text("status").notNull().default("linked"), // linked
  createdAt: integer("created_at").notNull(),
});
export type PaymentMethod = typeof paymentMethods.$inferSelect;

// Link a payment method. Only the type is client-supplied; the label/status are
// derived server-side so no card data can be smuggled in through the label.
export const linkPaymentMethodSchema = z.object({
  type: z.enum(["card", "sbp"]),
});
export type LinkPaymentMethodInput = z.infer<typeof linkPaymentMethodSchema>;

/* ------- SUPPORT TICKETS (rider help requests) ------- */
// Lightweight contact form persistence for the current user. Riders can submit
// a subject + message; staff handling happens out-of-band for the MVP.
export const supportTickets = sqliteTable("support_tickets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"), // open | resolved
  createdAt: integer("created_at").notNull(),
});
export type SupportTicket = typeof supportTickets.$inferSelect;

export const createSupportTicketSchema = z.object({
  subject: z
    .string({ required_error: "Укажите тему обращения" })
    .trim()
    .min(3, "Тема должна содержать минимум 3 символа")
    .max(120, "Слишком длинная тема"),
  message: z
    .string({ required_error: "Опишите вопрос" })
    .trim()
    .min(5, "Опишите вопрос подробнее (минимум 5 символов)")
    .max(2000, "Сообщение слишком длинное"),
});
export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;

/* ------- TYPES for API payloads ------- */
export type TariffId = "h1" | "h2" | "h3";
export interface TariffInfo {
  id: TariffId;
  name: string;
  price: number;
  unit: string;
  durationHours: number;
  description: string;
  popular?: boolean;
}
