import { pgTable, text, integer, bigint, doublePrecision, boolean, serial, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { feedbackTierForRating, FEEDBACK_REASON_IDS } from "./feedback";

/* ------- USERS (rider registration) ------- */
// Minimal rider identity captured at first rental. No sensitive payment data
// is ever stored here — only a display name and a contact phone. Phone is not
// ownership-verified yet (no SMS/OTP), so it is contact info, not auth.
export const users = pgTable("users", {
  id: text("id").primaryKey(),               // generated server-side
  name: text("name").notNull(),
  phone: text("phone").notNull(),            // normalized to digits with optional leading +
  email: text("email"),                      // optional, rider-supplied; validated on update
  emailVerifiedAt: bigint("email_verified_at", { mode: "number" }), // unix ms when email OTP was successfully verified; null = unverified
  role: text("role").notNull().default("rider"), // rider | mechanic | operator | admin
  consentAcceptedAt: bigint("consent_accepted_at", { mode: "number" }), // unix ms when consent was accepted
  consentVersion: text("consent_version"),   // e.g. "v1-2026-06-07"
  consentIp: text("consent_ip"),             // best-effort client IP captured at consent time
  blockedAt: bigint("blocked_at", { mode: "number" }),          // unix ms when an operator blocked the account; null = active
  blockedReason: text("blocked_reason"),     // optional operator-supplied note shown in the admin UI
  // Set when a rider permanently deletes their account. The row remains only
  // as an opaque ledger reference for completed rides and financial records;
  // all readable profile fields are anonymized at the same time.
  deletedAt: bigint("deleted_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }),          // unix ms of last profile mutation
}, (t) => [
  index("idx_users_phone").on(t.phone),
  index("idx_users_email").on(t.email),
  index("idx_users_deleted_created").on(t.deletedAt, t.createdAt.desc()),
]);
export type User = typeof users.$inferSelect;
export type UserRole = "rider" | "mechanic" | "operator" | "admin";

// Admin role assignment. Restricted to the known roles so an operator can't
// store an arbitrary string. Promotion to "admin" is gated server-side (only
// an admin may grant admin) — this schema just validates the value. "mechanic"
// is a service-only staff role (maintenance + read-only fleet).
export const adminSetRoleSchema = z.object({
  role: z.enum(["rider", "mechanic", "operator", "admin"]),
});
export type AdminSetRoleInput = z.infer<typeof adminSetRoleSchema>;

// Admin users list: base User row enriched with per-user ride/feedback
// aggregates, joined in at read time (never persisted). rideCount counts only
// completed rides; avgRating is null when the user has left no ride feedback.
export type AdminUser = User & { rideCount: number; avgRating: number | null };

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

// Profile self-service update: a rider may change their display name.
// Phone AND email are intentionally excluded here — changing either must go
// through their own OTP verification flow (phone via SMS, email via RuSender).
export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Имя должно содержать минимум 2 символа")
    .max(80, "Имя слишком длинное")
    .optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/* ------- OTP REQUESTS (SMS phone verification) ------- */
// One pending verification per phone. The code is never stored in plaintext —
// only an HMAC of the code is kept server-side. A row is created/replaced when
// a rider asks for a code and consumed once verification succeeds.
export const otpRequests = pgTable("otp_requests", {
  phone: text("phone").primaryKey(),         // normalized +7… form
  codeHash: text("code_hash").notNull(),     // HMAC-SHA256 of the OTP, never plaintext
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),// unix ms — code invalid after this
  attempts: integer("attempts").notNull().default(0),     // wrong-code tries used
  lastSentAt: bigint("last_sent_at", { mode: "number" }).notNull(),          // unix ms of last SMS, for resend lock
  consumed: boolean("consumed").notNull().default(false),
  // Delivery diagnostics for the last SMS send. SigmaSMS (and similar) return a
  // sending id + status that we persist so staff can later query the provider's
  // delivery status. None of these hold secrets — only the provider name, the
  // provider's sending id, its status text and any safe error summary.
  provider: text("provider"),                      // "sigmasms" | "smsru" | null (dev)
  providerMessageId: text("provider_message_id"),  // provider's sending id, if returned
  providerStatus: text("provider_status"),         // last known provider status text
  providerError: text("provider_error"),           // safe provider error summary (no secrets)
  providerCheckedAt: bigint("provider_checked_at", { mode: "number" }),// unix ms of last status refresh
});
export type OtpRequest = typeof otpRequests.$inferSelect;

// Step 1: request a code to a phone. Works for both login (existing account)
// and registration (new account) — the caller doesn't know which yet; the
// server decides based on whether the phone is already registered and tells
// the client via /verify's `status` field.
export const otpStartSchema = z.object({
  phone: z
    .string({ required_error: "Введите номер телефона" })
    .trim()
    .min(1, "Введите номер телефона"),
});
export type OtpStartInput = z.infer<typeof otpStartSchema>;

// Step 2: verify the code the rider received by SMS.
export const otpVerifySchema = z.object({
  phone: z.string({ required_error: "Введите номер телефона" }).trim().min(1),
  code: z
    .string({ required_error: "Введите код из SMS" })
    .trim()
    .regex(/^\d{6}$/, "Код состоит из 6 цифр"),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

// Step 3 (new accounts only): after the phone's OTP has been verified (proven
// by the server-side `pendingPhone` session, not by anything the client
// submits here — see /api/auth/register-complete), collect the remaining
// profile fields and consent to finish creating the account.
export const registerCompleteSchema = z.object({
  name: z
    .string({ required_error: "Введите имя" })
    .trim()
    .min(2, "Имя должно содержать минимум 2 символа")
    .max(80, "Имя слишком длинное"),
  email: z
    .string({ required_error: "Введите email" })
    .trim()
    .toLowerCase()
    .min(1, "Введите email")
    .email("Введите корректный email")
    .max(120, "Слишком длинный email"),
  consent: z.literal(true, {
    errorMap: () => ({ message: "Необходимо согласие на обработку персональных данных" }),
  }),
});
export type RegisterCompleteInput = z.infer<typeof registerCompleteSchema>;

/* ------- PHONE CHANGE (SMS OTP for an existing account) ------- */
// A logged-in rider changing their phone. Verification mirrors registration
// OTP but is keyed by the user id (not the phone) and carries the *new* phone
// through to the update. Only the HMAC of the code is stored. A row is
// created/replaced when the rider requests a code and consumed on success.
export const phoneChangeRequests = pgTable("phone_change_requests", {
  userId: text("user_id").primaryKey(),      // the rider changing their number
  newPhone: text("new_phone").notNull(),     // normalized +7… target number
  codeHash: text("code_hash").notNull(),     // HMAC-SHA256 of the OTP, never plaintext
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastSentAt: bigint("last_sent_at", { mode: "number" }).notNull(),
  consumed: boolean("consumed").notNull().default(false),
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
    .regex(/^\d{6}$/, "Код состоит из 6 цифр"),
});
export type PhoneChangeVerifyInput = z.infer<typeof phoneChangeVerifySchema>;

/* ------- EMAIL CHANGE (email OTP for an existing account) ------- */
// Mirrors phone_change_requests: one pending email verification per user. A
// 6-digit code is sent to the target address via RuSender; only its HMAC is
// stored. On success we set users.email + users.emailVerifiedAt. Used for both
// "link email to existing account" and "change existing verified email".
export const emailChangeRequests = pgTable("email_change_requests", {
  userId: text("user_id").primaryKey(),      // the rider changing their address
  newEmail: text("new_email").notNull(),     // lower-cased, validated target email
  codeHash: text("code_hash").notNull(),     // HMAC-SHA256 of the OTP, never plaintext
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastSentAt: bigint("last_sent_at", { mode: "number" }).notNull(),
  consumed: boolean("consumed").notNull().default(false),
});
export type EmailChangeRequest = typeof emailChangeRequests.$inferSelect;

// Step 1: request a code to a new email address.
export const emailChangeStartSchema = z.object({
  email: z
    .string({ required_error: "Введите email" })
    .trim()
    .toLowerCase()
    .email("Введите корректный email")
    .max(120, "Слишком длинный email"),
});
export type EmailChangeStartInput = z.infer<typeof emailChangeStartSchema>;

// Step 2: verify the code sent by email.
export const emailChangeVerifySchema = z.object({
  code: z
    .string({ required_error: "Введите код из письма" })
    .trim()
    .regex(/^\d{6}$/, "Код состоит из 6 цифр"),
});
export type EmailChangeVerifyInput = z.infer<typeof emailChangeVerifySchema>;

/* ------- OAUTH IDENTITIES (Yandex ID / VK ID) ------- */
// A single rider may have multiple linked OAuth identities. Provider + subject
// (the provider's stable user id) is the unique key. We never persist access
// or refresh tokens — only the identity mapping and a snapshot of the
// provider-side email/name for support/audit. Linking assigns an OAuth identity
// to an already-authenticated user; if a first-time OAuth login arrives without
// a session, we fall back to matching by verified email.
export const oauthIdentities = pgTable("oauth_identities", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),      // "yandex" | "vk"
  subject: text("subject").notNull(),        // provider's stable user id (string)
  email: text("email"),                      // provider-reported email at link time (may be null for VK)
  displayName: text("display_name"),         // provider-reported name at link time
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("idx_oauth_provider_subject").on(t.provider, t.subject),
  index("idx_oauth_user").on(t.userId),
]);
export type OauthIdentity = typeof oauthIdentities.$inferSelect;
export const OAUTH_PROVIDERS = ["yandex", "vk"] as const;
export type OauthProvider = typeof OAUTH_PROVIDERS[number];

/* ------- WEB PUSH SUBSCRIPTIONS ------- */
// Один пользователь может иметь несколько подписок (разные устройства/браузеры).
// Идентифицируем подписку по endpoint (URL push-сервиса FCM/APNs/Mozilla).
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  endpoint: text("endpoint").notNull(),         // уникальный URL push-сервиса
  p256dh: text("p256dh").notNull(),             // публичный ключ клиента (base64url)
  authKey: text("auth_key").notNull(),          // auth secret (base64url)
  userAgent: text("user_agent"),                // для отладки, необязательно
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  lastSuccessAt: bigint("last_success_at", { mode: "number" }),
}, (t) => [
  uniqueIndex("idx_push_endpoint").on(t.endpoint),
  index("idx_push_user").on(t.userId),
]);
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});
export type PushSubscribeBody = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

/* ------- BIKES ------- */
export const bikes = pgTable("bikes", {
  id: text("id").primaryKey(),               // e.g. "BC-014"
  model: text("model").notNull(),            // Cruiser / Comfort / City+
  status: text("status").notNull(),          // see BIKE_STATUSES below
  battery: integer("battery").notNull(),     // 0-100 (smart lock battery)
  lat: doublePrecision("lat").notNull(),                // map % space, see note below
  lng: doublePrecision("lng").notNull(),
  lastSeen: bigint("last_seen", { mode: "number" }).notNull(),  // unix ms
  idleHours: doublePrecision("idle_hours").notNull(),   // hours
  flagged: boolean("flagged").notNull().default(false),
  parkingId: text("parking_id").references(() => parkings.id, { onDelete: "set null" }), // optional home parking station id
  // ----- OMNI smart lock (TCP ingest, server/omni/) -----
  // The lock's IMEI is how an inbound TCP connection is resolved to a bike, so
  // it must be unique across the fleet — enforced by the partial UNIQUE index
  // below (NULL for every bike without a smart lock fitted).
  lockImei: text("lock_imei"),
  lockOnline: boolean("lock_online").notNull().default(false),
  lockLastSeen: bigint("lock_last_seen", { mode: "number" }),  // unix ms
  notes: text("notes"),                      // operator free-text notes
  // Set when status was auto-flipped to "maintenance" by system logic (e.g.
  // "auto:low_battery"), left null for operator-initiated maintenance. Lets
  // the sweep/heartbeat handler tell "already in maintenance for this exact
  // reason" apart from "operator put it there for something else", and lets
  // the UI show why a bike disappeared from the public list without a ticket.
  maintenanceReason: text("maintenance_reason"),
  // `seed` marks demo fleet rows so the demo reseed migration can refresh them
  // without ever touching bikes an operator added manually.
  seed: boolean("seed").notNull().default(false),
}, (t) => [
  index("idx_bikes_status").on(t.status),
  uniqueIndex("idx_bikes_lock_imei").on(t.lockImei).where(sql`${t.lockImei} IS NOT NULL`),
  index("idx_bikes_parking").on(t.parkingId),
]);

// Operational statuses. `available`/`rented`/`reserved` drive the rental flow;
// `maintenance`/`offline`/`storage`/`lost` take a bike out of rotation
// (including when an operator has manually put the OMNI lock itself into
// its own low-power sleep mode via the lock's vendor app — tracked under
// `storage`, not a separate status); and `archived` hides a retired bike
// from the public list (soft delete).
export const BIKE_STATUSES = [
  "available", "rented", "reserved", "maintenance", "offline", "storage", "lost", "archived",
] as const;
export type BikeStatus = (typeof BIKE_STATUSES)[number];

// Statuses a bike must NOT be in to be rentable from the public app/map.
export const RENTABLE_STATUSES: readonly BikeStatus[] = ["available", "reserved"];

export const insertBikeSchema = createInsertSchema(bikes);
export type InsertBike = z.infer<typeof insertBikeSchema>;
export type Bike = typeof bikes.$inferSelect;

/* ------- UNASSIGNED SMART LOCKS ------- */
// A lock that dialled in but is not fitted to any bike yet. The TCP ingest
// refuses to accept telemetry from an unknown IMEI, so without this table a
// freshly powered-on lock would be invisible and an operator would have no way
// to learn its IMEI short of reading it off the device.
//
// This is a discovery buffer, not a device registry: the registry is
// `bikes.lock_imei`. A row here is advisory and may be stale — an IMEI that has
// since been assigned is filtered out at read time rather than trusted.
export const unassignedLocks = pgTable("unassigned_locks", {
  imei: text("imei").primaryKey(),
  firstSeen: bigint("first_seen", { mode: "number" }).notNull(),  // unix ms
  lastSeen: bigint("last_seen", { mode: "number" }).notNull(),    // unix ms
});

/* ------- RESERVATIONS ("бронь") ------- */
// A short-lived hold on one bike for one user (10-minute default window, see
// RESERVATION_TTL_MS in shared/geo.ts). While `active`, the bike sits in
// status "reserved" and only THIS userId may claim it via /api/rides/start.
// A background sweep (server/index.ts) flips overdue rows to "expired" and
// the bike back to "available" — the row itself is kept (not deleted) as an
// audit trail of who booked what and whether they followed through.
export const reservations = pgTable("reservations", {
  id: serial("id").primaryKey(),
  bikeId: text("bike_id").notNull().references(() => bikes.id, { onUpdate: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("active"), // active | claimed | expired | cancelled
  claimedRideId: integer("claimed_ride_id").references(() => rides.id),
}, (t) => [
  index("idx_reservations_bike").on(t.bikeId),
  index("idx_reservations_user_status").on(t.userId, t.status),
  index("idx_reservations_active_expires").on(t.expiresAt).where(sql`${t.status} = 'active'`),
]);
export type Reservation = typeof reservations.$inferSelect;
export const RESERVATION_STATUSES = ["active", "claimed", "expired", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/* ------- OPS ALERTS ------- */
// System-raised alerts for the ops dashboard (unauthorized movement while
// reserved/available, low-battery auto-service transitions, etc). Distinct
// from `tickets`: alerts are machine-generated and ack-only (no assignee/
// comment workflow) — an operator either acknowledges one or opens a ticket
// from it.
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  bikeId: text("bike_id").notNull().references(() => bikes.id, { onUpdate: "cascade" }),
  kind: text("kind").notNull(),          // see ALERT_KINDS
  severity: text("severity").notNull().default("high"), // low | medium | high | critical
  message: text("message").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
  acknowledgedBy: text("acknowledged_by"),
}, (t) => [
  index("idx_alerts_bike").on(t.bikeId),
  index("idx_alerts_created").on(t.createdAt),
  index("idx_alerts_unacked").on(t.createdAt).where(sql`${t.acknowledgedAt} IS NULL`),
]);
export type Alert = typeof alerts.$inferSelect;
// "theft" (bike-status lifecycle spec, 2026-09): fired once when 6 consecutive
// "illegal movement" alarms with no reset auto-transition a bike to "lost"
// (server/omni/theft-registry.ts + store.ts) — distinct from the raw
// per-report "movement_alarm" above, which fires on every single alarm.
export const ALERT_KINDS = ["movement_alarm", "low_battery", "fall", "overage_charge_failed", "theft"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type UnassignedLock = typeof unassignedLocks.$inferSelect;

/** An OMNI IMEI as it appears on the wire: exactly 15 digits (protocol §1.1). */
export const lockImeiSchema = z
  .string()
  .trim()
  .regex(/^\d{15}$/, "IMEI замка: ровно 15 цифр");

/* ------- LOCK DEVICE REGISTRY ------- */
// The registry is deliberately separate from the legacy bikes.lock_imei field.
// A registered device can exist before installation, and later protocol work
// will resolve incoming IMEIs through this table without changing this admin
// CRUD contract.
//
// The app convention is unix-millisecond BIGINT values for timestamps (rather
// than PostgreSQL TIMESTAMP), so they remain consistent with the rest of the
// operational schema and JavaScript Date.now().
export const LOCK_STATUSES = [
  "unregistered", "installed", "active", "offline", "decommissioned",
] as const;
export type LockStatus = (typeof LOCK_STATUSES)[number];

// Connectivity/lifecycle status is deliberately separate from the physical
// latch state reported by the device protocol.
export const LOCK_STATES = ["locked", "unlocked"] as const;
export type LockState = (typeof LOCK_STATES)[number];

export const locks = pgTable("locks", {
  id: serial("id").primaryKey(),
  imei: text("imei").notNull(),
  macAddress: text("mac_address"),
  bikeId: text("bike_id").references(() => bikes.id, { onDelete: "set null", onUpdate: "cascade" }),
  simIccid: text("sim_iccid"),
  firmwareVersion: text("firmware_version"),
  apn: text("apn").notNull().default("cmiot"),
  status: text("status").notNull().default("unregistered"),
  lastSeenAt: bigint("last_seen_at", { mode: "number" }),
  lastBatteryVoltage: numeric("last_battery_voltage", { mode: "number" }),
  lastSignalStrength: integer("last_signal_strength"),
  // Gateway-owned telemetry from the Omni Horseshoe Lock TCP protocol.
  lastLockState: text("last_lock_state"),
  lastLatitude: numeric("last_latitude", { mode: "number" }),
  lastLongitude: numeric("last_longitude", { mode: "number" }),
  lastLocationAt: bigint("last_location_at", { mode: "number" }),
  bleKey: text("ble_key"),
  deviceTypeCode: text("device_type_code"),
  lastAlarmType: text("last_alarm_type"),
  lastAlarmAt: bigint("last_alarm_at", { mode: "number" }),
  notes: text("notes"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("idx_locks_imei").on(t.imei),
  index("idx_locks_bike_id").on(t.bikeId),
  index("idx_locks_status").on(t.status),
]);
export type Lock = typeof locks.$inferSelect;

// Onboard OMNI smart-lock reports (wire protocol in shared/omni/protocol.ts).
// See server/db/bootstrap.ts's historical comment for the per-cmd column
// layout; storage.ts/omni ingest use raw `sql` templates against this table
// rather than the query builder, but it is modelled here so schema
// migrations manage it like every other table.
export const bikeTelemetry = pgTable("bike_telemetry", {
  id: serial("id").primaryKey(),
  bikeId: text("bike_id").notNull(),
  imei: text("imei"),
  cmd: text("cmd").notNull().default("D0"),
  t: bigint("t", { mode: "number" }).notNull(),
  x: doublePrecision("x"),
  y: doublePrecision("y"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  satellites: integer("satellites"),
  hdop: doublePrecision("hdop"),
  altitudeM: doublePrecision("altitude_m"),
  voltageCv: integer("voltage_cv"),
  batteryPct: integer("battery_pct"),
  signalLevel: integer("signal_level"),
  locked: boolean("locked"),
  alarmCode: integer("alarm_code"),
}, (t) => [
  index("idx_bike_telemetry_bike_t").on(t.bikeId, t.t),
  // Most rows are positionless check-ins/heartbeats; the ride-track query
  // only wants rows carrying a fix, so keep the index partial.
  index("idx_bike_telemetry_pos").on(t.bikeId, t.t).where(sql`${t.x} IS NOT NULL`),
]);
export type BikeTelemetry = typeof bikeTelemetry.$inferSelect;

// Free-form server-owned key/value store (schema version marker, feature
// flags, one-off operational switches). Never exposed directly over the API.
export const meta = pgTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export type Meta = typeof meta.$inferSelect;

const optionalText = (max: number) => z.union([z.string().trim().max(max), z.literal("")]).optional();

// Admin registry creation accepts provisioning/inspection metadata, while
// gateway-owned telemetry, server-owned id, and audit timestamps are never
// client-controlled.
export const adminCreateLockSchema = z.object({
  imei: lockImeiSchema,
  macAddress: optionalText(64),
  bikeId: optionalText(20),
  simIccid: optionalText(32),
  firmwareVersion: optionalText(100),
  apn: optionalText(100),
  status: z.enum(LOCK_STATUSES).optional(),
  notes: optionalText(2_000),
});
export type AdminCreateLockInput = z.infer<typeof adminCreateLockSchema>;

// Binding, lifecycle, operator notes, and manually recorded provisioning metadata
// are mutable. Gateway-owned telemetry remains outside the admin contract.
export const adminUpdateLockSchema = z.object({
  bikeId: optionalText(20),
  macAddress: optionalText(64),
  simIccid: optionalText(32),
  firmwareVersion: optionalText(100),
  apn: optionalText(100),
  status: z.enum(LOCK_STATUSES).optional(),
  notes: optionalText(2_000),
});
export type AdminUpdateLockInput = z.infer<typeof adminUpdateLockSchema>;

/** A sighting older than this is neither offered to operators nor kept. */
export const UNASSIGNED_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rows kept before new IMEIs stop being recorded. The lock port is public and
 * IMEIs are spoofable, so this table must not become an unbounded write target;
 * expired rows are pruned on write, which keeps room for real locks.
 */
export const UNASSIGNED_LOCK_MAX_ROWS = 500;

// Admin: create a bike. Id/lock IMEI required; status defaults to available.
// Map coordinates are optional (default to a station/centre server-side).
// Battery defaults to 100 for a freshly provisioned lock. Model is fixed
// server-side (DEFAULT_BIKE_MODEL), not accepted from the client.
export const bikeIdRegex = /^[A-Za-z0-9-]{2,20}$/;
// Model is no longer client-editable — every bike is provisioned with this
// fixed model server-side (see storage.createBike). The DB column stays
// NOT NULL for backward-compat with existing display/export code.
export const DEFAULT_BIKE_MODEL = "City Bicycle";
export const adminCreateBikeSchema = z.object({
  id: z.string().trim().regex(bikeIdRegex, "Код: латиница, цифры и дефис (2–20 символов)"),
  // Required: a bike without a lock cannot be rented or tracked, and the only
  // way an operator learns an IMEI is by picking a lock that has dialled in.
  lockImei: lockImeiSchema,
  status: z.enum(BIKE_STATUSES).default("available"),
  battery: z.number().int().min(0).max(100).default(100),
  parkingId: z.union([z.string().trim().max(40), z.literal("")]).optional(),
  notes: z.union([z.string().trim().max(500), z.literal("")]).optional(),
});
export type AdminCreateBikeInput = z.infer<typeof adminCreateBikeSchema>;

// Admin: edit a bike. All fields optional. `id` (the bike's own code) is now
// editable post-creation — omitted means "keep the current code"; see
// storage.adminUpdateBike for the rename transaction and its guards.
export const adminUpdateBikeSchema = z.object({
  id: z.string().trim().regex(bikeIdRegex, "Код: латиница, цифры и дефис (2–20 символов)").optional(),
  // Optional on edit: a lock can be swapped when the fitted one dies, but an
  // untouched form must not have to resend it.
  lockImei: lockImeiSchema.optional(),
  status: z.enum(BIKE_STATUSES).optional(),
  battery: z.number().int().min(0).max(100).optional(),
  parkingId: z.union([z.string().trim().max(40), z.literal("")]).optional(),
  notes: z.union([z.string().trim().max(500), z.literal("")]).optional(),
});
export type AdminUpdateBikeInput = z.infer<typeof adminUpdateBikeSchema>;

/* ------- PARKING STATIONS ------- */
// Operator-managed parking points. Coordinates are stored in the same abstract
// 1000x700 map space as bikes (lng = x, lat = y) so they map to real Yandex
// coordinates via mapToReal(). `status` gates public visibility: only "active"
// parkings reach the public /api/parkings. `archivedAt` is a soft delete that
// hides a point everywhere while keeping it referenceable from bikes/history.
export const parkings = pgTable("parkings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  city: text("city").notNull().default(""),   // город для группировки/сортировки в операторской
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  capacity: integer("capacity").notNull(),
  occupied: integer("occupied").notNull(),
  radius: integer("radius").notNull().default(30), // matching radius in metres
  status: text("status").notNull().default("active"), // active | inactive
  notes: text("notes"),                  // operator instructions / free-text
  archivedAt: bigint("archived_at", { mode: "number" }),    // unix ms when archived; null = live
  // `seed` marks the demo parkings so a future reseed can refresh them without
  // touching operator-added points (mirrors the bikes table convention).
  seed: boolean("seed").notNull().default(false),
  createdAt: bigint("created_at", { mode: "number" }),      // unix ms; null for legacy demo rows
  updatedAt: bigint("updated_at", { mode: "number" }),      // unix ms of last mutation
});
export type Parking = typeof parkings.$inferSelect;

export const PARKING_STATUSES = ["active", "inactive"] as const;
export type ParkingStatus = (typeof PARKING_STATUSES)[number];

// Фиксированный список городов присутствия. Добавить новый = дописать сюда
// (значение хранится как есть, отдельной таблицы городов не заводим).
export const PARKING_CITIES = ["Калининград", "Зеленоградск", "Пионерский", "Балтийск", "Светлогорск"] as const;
export type ParkingCity = (typeof PARKING_CITIES)[number];

// Admin: create a parking point. Coordinates are required (picked on the map or
// typed manually). Capacity defaults to a sensible rack size; occupied starts
// at 0 for a freshly provisioned point.
const parkingIdRegex = /^[A-Za-z0-9-]{2,40}$/;
export const adminCreateParkingSchema = z.object({
  id: z.union([z.string().trim().regex(parkingIdRegex, "Код: латиница, цифры и дефис (2–40 символов)"), z.literal("")]).optional(),
  name: z.string().trim().min(2, "Укажите название").max(120),
  city: z.enum(PARKING_CITIES, { errorMap: () => ({ message: "Выберите город" }) }),
  lat: z.number().finite(),
  lng: z.number().finite(),
  capacity: z.number().int().min(0).max(1000).default(10),
  occupied: z.number().int().min(0).max(1000).default(0),
  radius: z.number().int().min(1).max(1000).default(30),
  status: z.enum(PARKING_STATUSES).default("active"),
  notes: z.union([z.string().trim().max(500), z.literal("")]).optional(),
});
export type AdminCreateParkingInput = z.infer<typeof adminCreateParkingSchema>;

// Admin: edit a parking point. All fields optional; id is immutable (path param).
export const adminUpdateParkingSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  city: z.enum(PARKING_CITIES).optional(),
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
  capacity: z.number().int().min(0).max(1000).optional(),
  occupied: z.number().int().min(0).max(1000).optional(),
  radius: z.number().int().min(1).max(1000).optional(),
  status: z.enum(PARKING_STATUSES).optional(),
  notes: z.union([z.string().trim().max(500), z.literal("")]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "Нет изменений" });
export type AdminUpdateParkingInput = z.infer<typeof adminUpdateParkingSchema>;

/* ------- ZONES (operating / restricted / forbidden) ------- */
/** zone.kind = "operating" | "slow" | "forbidden"
 *  polygon = JSON array of [x,y] map points
 */
export const zones = pgTable("zones", {
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
export const mapObjects = pgTable("map_objects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  kind: text("kind").notNull(),
  color: text("color").notNull().default("#1d6f8e"),
  points: text("points").notNull(),
  // Inactive objects are kept in the editor but never rendered on the public map.
  active: boolean("active").notNull().default(true),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
export type MapObject = typeof mapObjects.$inferSelect;
export const insertMapObjectSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["route", "operating", "slow", "forbidden"]),
  kind: z.enum(["route", "zone"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1d6f8e"),
  points: z.array(z.tuple([z.number(), z.number()])).min(2),
  active: z.boolean().default(true),
});
export type InsertMapObject = z.infer<typeof insertMapObjectSchema>;

// Admin: patch a map object. Every field is optional; supplying `points`
// (with kind/color/name) lets the editor overwrite geometry in place.
export const updateMapObjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: z.enum(["route", "operating", "slow", "forbidden"]).optional(),
  kind: z.enum(["route", "zone"]).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  points: z.array(z.tuple([z.number(), z.number()])).min(2).optional(),
  active: z.boolean().optional(),
});
export type UpdateMapObjectInput = z.infer<typeof updateMapObjectSchema>;

/* ------- RIDES ------- */
export const rides = pgTable("rides", {
  id: serial("id").primaryKey(),
  bikeId: text("bike_id").notNull().references(() => bikes.id, { onUpdate: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  endedAt: bigint("ended_at", { mode: "number" }),
  startLat: doublePrecision("start_lat").notNull(),
  startLng: doublePrecision("start_lng").notNull(),
  endLat: doublePrecision("end_lat"),
  endLng: doublePrecision("end_lng"),
  track: text("track").notNull(),     // JSON: [[x,y,t], ...]
  distanceM: doublePrecision("distance_m").notNull().default(0),
  cost: integer("cost").notNull().default(0),   // stored in kopecks (integer) — never float rubles
  tariff: text("tariff").notNull(),
  // Cumulative purchased duration in hours: the initial tariff's durationHours
  // at startRide, incremented by each extendRide's tariff.durationHours. Used
  // for display (the "2 часа" label after a 1ч+1ч extension) instead of the
  // raw `tariff` id, which only ever reflects the LAST tariff purchased and
  // was never meant to represent a cumulative total — see shared/geo.ts's
  // tariffLabelForHours(). Independent of paidUntilAt, which also absorbs
  // pause-grace credits and must not be used to derive this.
  totalTariffHours: integer("total_tariff_hours").notNull().default(0),
  // Same cumulative total as totalTariffHours above, but in milliseconds —
  // needed because sub-hour tariffs (durationHours: 0, e.g. the "m1" test
  // tariff) can't be represented in the hours counter at all: every
  // extension of such a tariff added 0, so the ride's displayed tariff label
  // never reflected extensions (shared/geo.ts's tariffLabelForRide uses this
  // field, not totalTariffHours, for exactly that reason). 0 for historical
  // rows created before this column existed — tariffLabelForRide falls back
  // to the ride's own tariff id in that case, same as it always did.
  totalTariffMs: bigint("total_tariff_ms", { mode: "number" }).notNull().default(0),
  status: text("status").notNull(),   // active | completed | cancelled
  // Set when the OMNI lock reports a physical close (L1) while this ride was
  // still "active" — i.e. the rider closed the lock without the app calling
  // /api/rides/:id/end (audit F-04). Ops-visibility only; never auto-set the
  // ride to completed/cancelled from this.
  physicallyLockedAt: bigint("physically_locked_at", { mode: "number" }),
  // Absolute deadline of the currently-paid window (unix ms). Set at start =
  // startedAt + tariff duration; extended by /rides/:id/extend and by the
  // paused-time grace (see pausedAt below). Once now() passes this, billing
  // switches to the per-minute overage rate. Nullable only for historical
  // rows created before this column existed.
  paidUntilAt: bigint("paid_until_at", { mode: "number" }),
  // Unix ms when the CURRENT pause started; null when not paused. On resume,
  // the elapsed pause is applied against the 10-minute free grace (see
  // shared/pause.ts) and paidUntilAt/totalPausedMs are updated accordingly.
  pausedAt: bigint("paused_at", { mode: "number" }),
  // Cumulative real (wall-clock) paused duration across every pause in this
  // ride, for ops visibility/analytics. Does not by itself affect billing —
  // only the grace-adjusted extension to paidUntilAt does.
  totalPausedMs: integer("total_paused_ms").notNull().default(0),
  // Set once we've pushed the "paid time is over, per-minute billing started"
  // notification, so the overage sweep never double-sends it.
  overageNotifiedAt: bigint("overage_notified_at", { mode: "number" }),
  // The parking the bike was standing in when this ride started (copied from
  // bikes.parking_id at start time). Used by the 5-minute cancel-with-refund
  // rule: eligible only while the bike is still at this same parking.
  startParkingId: text("start_parking_id").references(() => parkings.id, { onDelete: "set null" }),
  // Was copied from bikes.is_test_bike at startRide time; that per-bike flag
  // was removed (no more designated test units), so this is now hardcoded
  // false by storage.startRide. Column kept for backward-compat with existing
  // rows/analytics rather than dropped outright.
  isTest: boolean("is_test").notNull().default(false),
  // Which of the rider's up-to-MAX_ACTIVE_RIDES_PER_USER concurrent active
  // rides this is: 1 or 2 while status='active', reset to null the moment
  // status leaves 'active' (end/cancel). Backs the partial unique index
  // idx_rides_active_user (user_id, active_slot) — see server/db/bootstrap.ts
  // createRideRaceGuardIndexes() — which replaced the old "1 active ride per
  // user" unique index when two-bikes-per-rider shipped. Null for every
  // historical/non-active row.
  activeSlot: integer("active_slot"),
}, (t) => [
  index("idx_rides_user_status").on(t.userId, t.status),
  index("idx_rides_user").on(t.userId),
  index("idx_rides_bike").on(t.bikeId),
  index("idx_rides_started").on(t.startedAt),
  index("idx_rides_user_started").on(t.userId, t.startedAt.desc()),
  // Backs the reservation-expiry / overage-notification sweep's scan for
  // active rides without a full table scan.
  index("idx_rides_status_paid_until").on(t.status, t.paidUntilAt),
]);
export type Ride = typeof rides.$inferSelect;
export const insertRideSchema = createInsertSchema(rides);

// A ride enriched with the rider's post-ride feedback rating (1..5, or null
// if the rider never submitted feedback / the ride is still active) — for
// list views (rider history, admin rides table) that show the rating
// alongside the ride without a separate per-row fetch. Batched from
// ride_feedback the same way AdminRide batches userName/userPhone below.
export type RideWithFeedback = Ride & {
  rating: number | null;
};

// Track points recorded during a ride, in abstract map space (matching
// bike_telemetry's x/y). storage.ts queries this table with raw `sql`
// templates (loadRidePoints) rather than the query builder, but it is
// modelled here so schema migrations (drizzle-kit generate) create/alter it
// like every other table instead of relying on ad-hoc bootstrap DDL.
export const ridePoints = pgTable("ride_points", {
  id: serial("id").primaryKey(),
  rideId: integer("ride_id").notNull(),
  x: doublePrecision("x").notNull(),
  y: doublePrecision("y").notNull(),
  t: bigint("t", { mode: "number" }).notNull(),
}, (t) => [
  index("idx_ride_points_ride").on(t.rideId, t.id),
]);
export type RidePoint = typeof ridePoints.$inferSelect;

// A ride enriched with the rider's display name/phone for the admin rides
// table. Identity is resolved server-side from the users table; an unknown or
// demo rider yields null name/phone so the UI can fall back to the raw id.
export type AdminRide = Ride & {
  userName: string | null;
  userPhone: string | null;
  rating: number | null;
};

/* ------- POST-RIDE FEEDBACK ------- */
// One feedback row per ride, submitted by the rider right after ending it
// (client-triggered — never forced, always skippable). `reasons` holds ids
// from the pool matching the submitted rating's tier (shared/feedback.ts).
// Reason ids are re-validated against that pool server-side in
// storage.submitRideFeedback — this schema only checks shape, not content,
// because the allowed set depends on `rating` (cross-field).
export const rideFeedback = pgTable("ride_feedback", {
  id: serial("id").primaryKey(),
  rideId: integer("ride_id").notNull().references(() => rides.id),
  userId: text("user_id").notNull().references(() => users.id),
  rating: integer("rating").notNull(),   // 1..5
  reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
  comment: text("comment"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [
  // One feedback per ride — resubmitting (e.g. dialog reopened) updates the
  // existing row instead of creating a duplicate (see onConflictDoUpdate).
  uniqueIndex("uidx_ride_feedback_ride").on(t.rideId),
  index("idx_ride_feedback_rating").on(t.rating),
  index("idx_ride_feedback_created").on(t.createdAt),
  // Audit (scalability): listUsers()'s per-user rating aggregate does
  // `WHERE user_id IN (...) GROUP BY user_id` — without this it's a full
  // table scan that grows with total feedback rows, not user count.
  index("idx_ride_feedback_user").on(t.userId),
]);
export type RideFeedback = typeof rideFeedback.$inferSelect;

// Feedback row enriched with rider identity + bike id for the admin Reviews
// list, mirroring how AdminRide enriches Ride above. bikeId/userName/userPhone
// are resolved server-side (bikeId via the ride, name/phone via the feedback's
// own userId — always the ride owner, see submitRideFeedback).
export type AdminRideFeedback = RideFeedback & {
  bikeId: string | null;
  userName: string | null;
  userPhone: string | null;
};

export const createRideFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  reasons: z.array(z.string().trim().min(1).max(40)).max(15).default([]),
  comment: z.union([z.string().trim().max(500), z.literal("")]).optional(),
});
export type CreateRideFeedbackInput = z.infer<typeof createRideFeedbackSchema>;

// Re-exported so server storage doesn't need a second import from
// shared/feedback.ts just for these two symbols.
export { feedbackTierForRating, FEEDBACK_REASON_IDS };

/* ------- SERVICE / MAINTENANCE TICKETS ------- */
// Operational service tickets for the fleet. A ticket tracks one issue on one
// bike through its lifecycle (new → in progress → resolved/closed). `kind`
// carries either a human-reported issue type (see TICKET_KINDS) or one of the
// legacy auto-flag kinds kept for backward compatibility with seeded rows.
export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  bikeId: text("bike_id").notNull().references(() => bikes.id, { onUpdate: "cascade" }),
  kind: text("kind").notNull(),          // issue type — see TICKET_KINDS
  priority: text("priority").notNull().default("medium"), // see TICKET_PRIORITIES
  title: text("title").notNull().default(""),     // short summary
  message: text("message").notNull(),    // description
  assignee: text("assignee"),            // optional free-text assignee name
  status: text("status").notNull(),      // see TICKET_STATUSES
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }),      // unix ms of last mutation
  closedAt: bigint("closed_at", { mode: "number" }),        // unix ms when resolved/closed/cancelled
}, (t) => [
  index("idx_tickets_bike").on(t.bikeId),
  index("idx_tickets_created").on(t.createdAt),
  index("idx_tickets_status").on(t.status),
]);
export type Ticket = typeof tickets.$inferSelect;

// History / comment entries attached to a ticket. Each row is either a free-text
// operator comment or an auto-generated event note (status change, creation).
export const ticketComments = pgTable("ticket_comments", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  author: text("author").notNull(),     // operator display name or "Система"
  body: text("body").notNull(),
  kind: text("kind").notNull().default("comment"), // comment | event
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [
  index("idx_ticket_comments_ticket").on(t.ticketId),
]);
export type TicketComment = typeof ticketComments.$inferSelect;

// A ticket enriched with its comment/history thread for the detail view.
export type TicketWithComments = Ticket & { comments: TicketComment[] };

// Issue types (Russian labels live in the client). The id is stored in
// `tickets.kind`. The first set are operator-reportable; the legacy auto-flag
// kinds remain valid so old seeded/auto-generated rows still render.
export const TICKET_KINDS = [
  "wheel_puncture", "brakes", "chain", "handlebar_saddle", "lock",
  "qr_sticker", "dirty", "lost", "other",
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
const LEGACY_TICKET_KINDS = ["low_battery", "suspicious_idle", "repair_request", "out_of_zone"] as const;
const ALL_TICKET_KINDS = [...TICKET_KINDS, ...LEGACY_TICKET_KINDS] as const;

// Priorities, lowest → highest. high/critical bikes get pulled into maintenance.
export const TICKET_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

// Ticket lifecycle. `new` is the entry state (stored as "new"); the legacy
// "open" value is treated as equivalent and accepted on input for old rows.
export const TICKET_STATUSES = [
  "new", "in_progress", "waiting_parts", "resolved", "closed", "cancelled",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
// Statuses that take a ticket out of the active queue.
export const TICKET_CLOSED_STATUSES: readonly string[] = ["resolved", "closed", "cancelled"];

// Create a service ticket. Bike + kind required; the rest have sensible
// defaults so the quick-report flow stays light.
export const createTicketSchema = z.object({
  bikeId: z.string().trim().min(1, "Укажите велосипед").max(20),
  kind: z.enum(ALL_TICKET_KINDS as unknown as [string, ...string[]]).default("other"),
  priority: z.enum(TICKET_PRIORITIES).default("medium"),
  title: z.union([z.string().trim().max(120), z.literal("")]).optional(),
  message: z.string().trim().min(2, "Опишите проблему").max(2000),
  assignee: z.union([z.string().trim().max(80), z.literal("")]).optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// Update a ticket: any subset of status/priority/assignee. `returnBikeToAvailable`
// is an action flag used when closing — it asks the server to flip the bike back
// to available rather than mutating the ticket directly.
export const updateTicketSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assignee: z.union([z.string().trim().max(80), z.literal("")]).optional(),
  returnBikeToAvailable: z.boolean().optional(),
}).refine(
  (v) => v.status !== undefined || v.priority !== undefined || v.assignee !== undefined,
  { message: "Нет изменений" },
);
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

// Add a comment to a ticket's history thread.
export const addTicketCommentSchema = z.object({
  body: z.string().trim().min(1, "Введите комментарий").max(2000),
});
export type AddTicketCommentInput = z.infer<typeof addTicketCommentSchema>;

/* ------- PAYMENTS / BALANCE (single demo user) ------- */
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  amount: integer("amount").notNull(), // kopecks (integer, signed) — never float rubles
  kind: text("kind").notNull(),       // topup | ride_charge | tariff_purchase
  description: text("description").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  // Client-supplied idempotency token for wallet mutations that don't already
  // go through payment_orders (audit MEDIUM: wallet/tariff was not
  // idempotent). Same pattern as payment_orders.idempotencyKey (audit HIGH
  // #2): a retried request with the SAME key replays the original payment
  // row instead of debiting the wallet twice. Only set for kinds that opt in
  // (currently tariff_purchase); NULL for everything else, so the partial
  // unique index below never constrains rows that never carry a key.
  idempotencyKey: text("idempotency_key"),
}, (t) => [
  index("idx_payments_user").on(t.userId),
  uniqueIndex("idx_payments_user_idempotency").on(t.userId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
  index("idx_payments_user_created").on(t.userId, t.createdAt.desc()),
]);
export type Payment = typeof payments.$inferSelect;

export const wallet = pgTable("wallet", {
  userId: text("user_id").primaryKey().references(() => users.id),
  balance: integer("balance").notNull().default(0), // kopecks (integer) — never float rubles
  activeTariff: text("active_tariff").notNull().default("payg"),
  tariffExpiresAt: bigint("tariff_expires_at", { mode: "number" }),
});
export type Wallet = typeof wallet.$inferSelect;

/* ------- PAYMENT METHODS (T-Bank card binding metadata, no card data) ------- */
// A rider's linked payment methods. Strictly metadata — never a real card
// number, CVC, or full token. For real T-Bank bindings we store the provider
// identifiers returned by the acquirer (CustomerKey, CardId, RebillId) plus a
// masked PAN label and a lifecycle status. The PAN/CVC themselves are entered
// only on T-Bank's hosted form and never reach our servers.
export const paymentMethods = pgTable("payment_methods", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),              // card | sbp
  label: text("label").notNull(),            // display label, e.g. "•••• 4242" / "СБП"
  brand: text("brand"),                      // payment system: "visa" | "mastercard" | "mir" (derived from PAN BIN); null when unknown
  status: text("status").notNull().default("linked"), // pending | active | failed | linked (legacy)
  // ----- Real T-Bank metadata (added for the acquiring integration) -----
  provider: text("provider"),                // "tbank" for real bindings; null for legacy MVP rows
  customerKey: text("customer_key"),         // T-Bank CustomerKey (== our user id)
  cardId: text("card_id"),                   // T-Bank CardId once the card is bound
  // T-Bank RebillId for recurring charges (if returned). A bearer token — whoever
  // holds it can make the acquirer pull money from the rider's card. Encrypted at
  // rest (audit HIGH #9, AES-256-GCM — see server/crypto/payment-tokens.ts); the
  // storage layer decrypts on read so the rest of the app still sees plaintext.
  rebillId: text("rebill_id"),
  // Deterministic HMAC blind index of the decrypted rebillId, used for exact-match
  // lookups (e.g. same-card dedup) that can't run against the encrypted column.
  rebillIdHash: text("rebill_id_hash"),
  requestKey: text("request_key"),           // AddCard / AddAccountQr RequestKey, to correlate the binding & poll GetAddCardState / GetAddAccountQrState
  // SBP (СБП) account binding: the AccountToken issued by the payer's bank after
  // a successful AddAccountQr. It is the СБП analogue of a card's RebillId — the
  // recurring token we pass to ChargeQr to debit the linked account. Populated
  // from the binding notification (never a secret card number). Same encrypted-
  // at-rest treatment as rebillId (audit HIGH #9).
  accountToken: text("account_token"),
  accountTokenHash: text("account_token_hash"), // blind index, mirrors rebillIdHash
  // ----- Init+Recurrent verification-payment binding (the primary path) -----
  purpose: text("purpose"),                  // "card_binding" for the Init verification payment; null otherwise
  orderId: text("order_id"),                 // our Init OrderId, echoed back in notifications to correlate
  paymentId: text("payment_id"),             // T-Bank PaymentId returned by Init
  paymentUrl: text("payment_url"),           // hosted PaymentURL the rider opens (not a secret)
  amountKopecks: integer("amount_kopecks"),  // verification-payment amount in kopecks (e.g. 100 = 1 ₽)
  // Refund/reversal state for the 1 ₽ verification charge (Init+Recurrent path).
  // "none" = no charge to refund (AddCard path); "pending" = refund scheduled but
  // not yet confirmed; "refunded" = Cancel succeeded (AUTHORIZED→reversal, no debit,
  // won't appear in the cabinet's "Возвраты"; CONFIRMED→a real refund that does);
  // "failed" = Cancel could not complete (the 1 ₽ may be stuck — see refundError).
  refundStatus: text("refund_status"),       // none | pending | refunded | failed
  refundError: text("refund_error"),         // human-readable reason when refundStatus = failed (acquirer message; never a secret)
  // Last binding error from T-Bank (notification or GetAddCardState). Acquirer
  // fields only — never a secret — so the UI/support can see WHY a bind failed.
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  lastErrorDetails: text("last_error_details"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }),          // unix ms of last status change
}, (t) => [
  index("idx_pm_user").on(t.userId),
  index("idx_pm_user_provider_status").on(t.userId, t.provider, t.status),
  index("idx_pm_order").on(t.orderId),
  index("idx_pm_request_key").on(t.requestKey),
  index("idx_pm_rebill_hash").on(t.rebillIdHash),
  index("idx_pm_account_hash").on(t.accountTokenHash),
]);
export type PaymentMethod = typeof paymentMethods.$inferSelect;
// Audit LOW: the client-visible shape of a PaymentMethod. The server never
// sends rebillId/accountToken (charge-capable bearer tokens) or their blind-
// index hashes/customerKey (internal correlation only) to the browser — see
// toPublicPaymentMethod in server/http/payments.ts. hasRebillId/hasAccountToken
// carry the only signal the frontend ever actually needs from those fields.
export type PublicPaymentMethod = Omit<
  PaymentMethod,
  "rebillId" | "accountToken" | "rebillIdHash" | "accountTokenHash" | "customerKey"
> & { hasRebillId: boolean; hasAccountToken: boolean };

// Link a payment method. Only the type is client-supplied; the label/status are
// derived server-side so no card data can be smuggled in through the label.
export const linkPaymentMethodSchema = z.object({
  type: z.enum(["card", "sbp"]),
});
export type LinkPaymentMethodInput = z.infer<typeof linkPaymentMethodSchema>;

/* ------- PAYMENT ORDERS (T-Bank ordinary ride payment) ------- */
// One row per "pay now, then start the ride" attempt. This is the MVP payment
// path that does NOT rely on a saved card / RebillId: the rider pays the chosen
// tariff up front on T-Bank's hosted form, and the ride is started once the
// notification webhook confirms the payment. No card data is ever stored — only
// the acquirer's order/payment identifiers, amounts, and a lifecycle status.
export const paymentOrders = pgTable("payment_orders", {
  id: serial("id").primaryKey(),
  orderId: text("order_id").notNull().unique(),   // our Init OrderId (<= 50 chars, echoed in notifications)
  userId: text("user_id").notNull().references(() => users.id),
  bikeId: text("bike_id").notNull().references(() => bikes.id, { onUpdate: "cascade" }),
  tariffId: text("tariff_id").notNull(),          // h1 | h2 | h3
  amountKopecks: integer("amount_kopecks").notNull(),
  paymentId: text("payment_id"),                  // T-Bank PaymentId returned by Init
  paymentUrl: text("payment_url"),                // hosted PaymentURL the rider opens (not a secret)
  // How the rider paid: "hosted" = T-Bank hosted form (default MVP path);
  // "saved_card" = recurring Charge against a stored RebillId (no hosted form).
  source: text("source").notNull().default("hosted"),
  // For saved-card charges: which payment method (and its RebillId) was charged.
  // The RebillId is a recurring token, NOT card data — no PAN/CVC is ever stored.
  paymentMethodId: integer("payment_method_id"),
  rebillId: text("rebill_id"),                    // RebillId used for the saved-card charge
  // Discriminates a server-initiated charge from the two rider-initiated ones.
  // NULL (the historical default) keeps the existing convention: rideId ==
  // null means "ride start", rideId != null means "ride extend" (see
  // handleRidePaymentNotification/extendRideForPaidOrder). "ride_overage" is
  // the ONE new case that also carries a rideId but must NEVER be routed into
  // extendRideForPaidOrder — it settles an already-completed ride's overage,
  // not a new paid window, and must be checked BEFORE the rideId-null branch.
  purpose: text("purpose"),
  status: text("status").notNull().default("pending"), // pending | paid | failed
  rideId: integer("ride_id").references(() => rides.id), // set once the paid ride is started
  // Client-supplied idempotency token (audit HIGH #2): a retried /ride/init or
  // /ride/charge-saved-card request carries the SAME key, letting the server
  // replay the original order instead of creating a second payment/charge. The
  // partial UNIQUE index on (user_id, idempotency_key) below is the actual
  // database-level guarantee; this column just carries the value.
  idempotencyKey: text("idempotency_key"),
  // Last acquirer error (notification/Init), non-secret values only.
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  lastErrorDetails: text("last_error_details"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }),
}, (t) => [
  uniqueIndex("idx_po_user_idempotency").on(t.userId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
  index("idx_po_order").on(t.orderId),
  index("idx_po_user").on(t.userId),
  index("idx_po_payment").on(t.paymentId),
]);
export type PaymentOrder = typeof paymentOrders.$inferSelect;
export type PaymentOrderStatus = "pending" | "paid" | "failed";

// Start a ride by paying its tariff up front. Only the bike + tariff are
// client-supplied; the amount/price is resolved authoritatively server-side.
export const rideInitPaymentSchema = z.object({
  bikeId: z.string().trim().min(1, "Укажите велосипед").max(20),
  tariffId: z.enum(["h1", "h2", "h3", "m1"]),
});
export type RideInitPaymentInput = z.infer<typeof rideInitPaymentSchema>;

// Start a ride by charging the rider's SAVED card (stored RebillId) for the
// chosen tariff — no hosted form. Only the bike + tariff are required; the
// amount/price is resolved authoritatively server-side. paymentMethodId is
// optional: when omitted the server uses the rider's most recent active card.
export const rideChargeSavedCardSchema = z.object({
  bikeId: z.string().trim().min(1, "Укажите велосипед").max(20),
  tariffId: z.enum(["h1", "h2", "h3", "m1"]),
  paymentMethodId: z.number().int().positive().optional(),
});
export type RideChargeSavedCardInput = z.infer<typeof rideChargeSavedCardSchema>;

// Extend the rider's OWN currently-active ride by charging their saved card/SBP
// method — no hosted form. bikeId is deliberately NOT accepted from the client:
// the server resolves it (and validates ownership) from the rider's active ride,
// so a tampered bikeId can never redirect the charge to someone else's ride.
//
// rideId IS accepted (added when a rider can hold up to MAX_ACTIVE_RIDES_PER_USER
// concurrent active rides, so "the" active ride is no longer unambiguous) — but
// the server still never trusts it blindly: the handler re-verifies the row
// belongs to this userId AND is status==='active' before charging anything,
// preserving the original "never trust an unverified ride" guarantee explicitly
// instead of implicitly.
export const rideExtendSavedCardSchema = z.object({
  rideId: z.number().int().positive(),
  tariffId: z.enum(["h1", "h2", "h3", "m1"]),
  paymentMethodId: z.number().int().positive().optional(),
});
export type RideExtendSavedCardInput = z.infer<typeof rideExtendSavedCardSchema>;

/* ------- PAYMENT ORDERS (T-Bank wallet top-up) ------- */
// One row per "pay now, credit wallet once confirmed" attempt (audit CRITICAL
// #1 fix). The wallet balance is credited ONLY by the notification webhook
// once T-Bank confirms the charge (see server/payments/tbank-handlers.ts ->
// handleWalletTopupNotification) — never synchronously from the client-facing
// init route. This mirrors the ride payment_orders flow above; kept as its own
// table (rather than reusing payment_orders) because a top-up has no
// bike/tariff/ride, and payment_orders.bike_id/tariff_id are NOT NULL.
export const walletTopupOrders = pgTable("wallet_topup_orders", {
  id: serial("id").primaryKey(),
  orderId: text("order_id").notNull().unique(),   // our Init OrderId (<= 50 chars, echoed in notifications)
  userId: text("user_id").notNull(),
  amountKopecks: integer("amount_kopecks").notNull(),
  paymentId: text("payment_id"),                  // T-Bank PaymentId returned by Init
  paymentUrl: text("payment_url"),                // hosted PaymentURL the rider opens (not a secret)
  status: text("status").notNull().default("pending"), // pending | paid | failed
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  lastErrorDetails: text("last_error_details"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }),
}, (t) => [
  index("idx_wto_order").on(t.orderId),
  index("idx_wto_user").on(t.userId),
  index("idx_wto_payment").on(t.paymentId),
]);
export type WalletTopupOrder = typeof walletTopupOrders.$inferSelect;
export type WalletTopupOrderStatus = "pending" | "paid" | "failed";

// Client chooses how much to top up (in roubles); the server converts to
// kopecks and this is the ONLY client-supplied number in the whole flow — it
// is bounded here and re-validated nowhere else because it is the rider
// topping up their OWN wallet with their OWN money via a real T-Bank charge,
// not a price that could be manipulated to underpay for something.
export const walletTopupInitSchema = z.object({
  amount: z.number().positive().max(50000, "Максимум 50 000 ₽ за один платёж"),
});
export type WalletTopupInitInput = z.infer<typeof walletTopupInitSchema>;

/* ------- SUPPORT TICKETS (rider help requests) ------- */
// Lightweight contact form persistence for the current user. Riders can submit
// a subject + message; staff handling happens out-of-band for the MVP.
export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"), // open | resolved
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [
  index("idx_support_tickets_user").on(t.userId),
  index("idx_support_tickets_created").on(t.createdAt),
  index("idx_support_tickets_status").on(t.status),
]);
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

export const SUPPORT_TICKET_STATUSES = ["open", "resolved"] as const;
export type SupportTicketStatus = typeof SUPPORT_TICKET_STATUSES[number];

export const updateSupportTicketSchema = z.object({
  status: z.enum(SUPPORT_TICKET_STATUSES, { required_error: "Укажите статус" }),
});
export type UpdateSupportTicketInput = z.infer<typeof updateSupportTicketSchema>;

/* ------- SUPPORT CHAT (single continuous conversation per rider) ------- */
// Один непрерывный чат с поддержкой на пользователя. Все сообщения (текст
// или вложение) складываются в support_messages; support_conversations хранит
// метаданные (последнее сообщение, счётчики непрочитанного).
export const supportConversations = pgTable("support_conversations", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  // 'bot' — отвечает авто-скрипт по FAQ; 'human' — подключён оператор
  // (после запроса «оператор»). Бот больше не вмешивается в human-режиме.
  mode: text("mode").notNull().default("bot"),
  lastMessageAt: bigint("last_message_at", { mode: "number" }),
  userUnreadCount: integer("user_unread_count").notNull().default(0),
  operatorUnreadCount: integer("operator_unread_count").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [
  index("idx_support_conv_user").on(t.userId),
  index("idx_support_conv_last").on(t.lastMessageAt.desc()),
]);
export type SupportConversation = typeof supportConversations.$inferSelect;

export const SUPPORT_MESSAGE_ROLES = ["user", "operator", "system", "bot"] as const;
export type SupportMessageRole = typeof SUPPORT_MESSAGE_ROLES[number];

export const supportMessages = pgTable("support_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => supportConversations.id, { onDelete: "cascade" }),
  senderRole: text("sender_role").notNull(),
  senderId: text("sender_id"),
  body: text("body").notNull().default(""),
  attachmentUrl: text("attachment_url"),
  attachmentMime: text("attachment_mime"),
  readAt: bigint("read_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [
  index("idx_support_msg_conv").on(t.conversationId, t.id.desc()),
]);
export type SupportMessage = typeof supportMessages.$inferSelect;

export const sendSupportMessageSchema = z
  .object({
    body: z.string().trim().max(4000, "Слишком длинное сообщение").optional().default(""),
    attachmentUrl: z.string().trim().max(1024).optional(),
    attachmentMime: z.string().trim().max(120).optional(),
  })
  .refine((v) => (v.body?.length ?? 0) > 0 || !!v.attachmentUrl, {
    message: "Пустое сообщение",
  });
export type SendSupportMessageInput = z.infer<typeof sendSupportMessageSchema>;

// Enriched conversation shape для админки — с профилем клиента.
export type AdminSupportConversationRow = SupportConversation & {
  userName: string | null;
  userPhone: string | null;
  lastMessagePreview: string | null;
};
// mode уже входит в SupportConversation ('bot' | 'human').

// Enriched shape returned by admin endpoints — bundles rider info so the
// operator UI can render the request without extra round trips.
export type SupportTicketWithUser = SupportTicket & {
  userName: string | null;
  userPhone: string | null;
};

/* ------- TYPES for API payloads ------- */
export type TariffId = "h1" | "h2" | "h3" | "m1";
export interface TariffInfo {
  id: TariffId;
  name: string;
  price: number;
  unit: string;
  durationHours: number;
  description: string;
  popular?: boolean;
}
