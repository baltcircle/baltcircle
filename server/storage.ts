import {
  bikes, parkings, zones, rides, tickets, ticketComments, payments, wallet, mapObjects, users,
  otpRequests, phoneChangeRequests, paymentMethods, supportTickets,
  TICKET_CLOSED_STATUSES,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, Ticket, TicketComment, TicketWithComments, Payment, Wallet,
  MapObject, InsertMapObject, User, OtpRequest, UserRole, UpdateProfileInput,
  PhoneChangeRequest, PaymentMethod, SupportTicket,
  AdminCreateBikeInput, AdminUpdateBikeInput, CreateTicketInput, UpdateTicketInput,
} from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES, MAP_W, MAP_H,
} from "@shared/geo";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, sql } from "drizzle-orm";

const sqlite = new Database(process.env.DATABASE_PATH || "data.db");
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite);
// Exposed so the express-session store can reuse this single connection,
// keeping session rows in the same data.db that the Docker volume persists.
export const sqliteDb = sqlite;

// ---------- Schema bootstrap (since we skip drizzle migrations) ----------
sqlite.exec(`
CREATE TABLE IF NOT EXISTS bikes (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  battery INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  last_seen INTEGER NOT NULL,
  idle_hours REAL NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  serial TEXT,
  lock_id TEXT,
  parking_id TEXT,
  notes TEXT,
  seed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS parkings (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  capacity INTEGER NOT NULL, occupied INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL, polygon TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  end_lat REAL, end_lng REAL,
  track TEXT NOT NULL,
  distance_m REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tariff TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet (
  user_id TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0,
  active_tariff TEXT NOT NULL DEFAULT 'payg',
  tariff_expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS map_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#1d6f8e',
  points TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'rider',
  consent_accepted_at INTEGER,
  consent_version TEXT,
  consent_ip TEXT,
  blocked_at INTEGER,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS otp_requests (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS phone_change_requests (
  user_id TEXT PRIMARY KEY,
  new_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'linked',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
`);

// ---------- Users column migration (production user fields) ----------
// Older prototype DBs created the users table with only id/name/phone/created_at.
// Real-user fields (email, role, consent metadata, updated_at) are added in
// place via ALTER TABLE so existing rider rows are preserved. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we inspect the table and add what's missing.
function migrateUsersTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  addColumn("email", "email TEXT");
  addColumn("role", "role TEXT NOT NULL DEFAULT 'rider'");
  addColumn("consent_accepted_at", "consent_accepted_at INTEGER");
  addColumn("consent_version", "consent_version TEXT");
  addColumn("consent_ip", "consent_ip TEXT");
  addColumn("blocked_at", "blocked_at INTEGER");
  addColumn("blocked_reason", "blocked_reason TEXT");
  addColumn("updated_at", "updated_at INTEGER");
}
migrateUsersTable();

// ---------- Bikes column migration (real-fleet ops fields) ----------
// Older DBs created the bikes table before serial/lock/parking/notes/seed
// existed. Add the columns in place so existing demo + manual rows survive.
// Existing rows predate the manual-add feature, so they are the demo fleet —
// backfill seed = 1 for them so the demo reseed can still refresh them.
function migrateBikesTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(bikes)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE bikes ADD COLUMN ${ddl}`);
  };
  addColumn("serial", "serial TEXT");
  addColumn("lock_id", "lock_id TEXT");
  addColumn("parking_id", "parking_id TEXT");
  addColumn("notes", "notes TEXT");
  if (!cols.includes("seed")) {
    sqlite.exec("ALTER TABLE bikes ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
    // Pre-existing rows are the demo fleet — mark them so reseed can manage them.
    sqlite.exec("UPDATE bikes SET seed = 1");
  }
}
migrateBikesTable();

// ---------- Tickets column migration (service ticket fields) ----------
// Older DBs created tickets with only id/bike_id/kind/message/status/created_at.
// Add the service-operations columns in place so existing tickets survive, and
// normalise the legacy "open" status to the new "new" entry state.
function migrateTicketsTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE tickets ADD COLUMN ${ddl}`);
  };
  addColumn("priority", "priority TEXT NOT NULL DEFAULT 'medium'");
  addColumn("title", "title TEXT NOT NULL DEFAULT ''");
  addColumn("assignee", "assignee TEXT");
  addColumn("updated_at", "updated_at INTEGER");
  addColumn("closed_at", "closed_at INTEGER");
  sqlite.exec("UPDATE tickets SET status = 'new' WHERE status = 'open'");
}
migrateTicketsTable();

const MODELS = ["BC Cruiser", "BC Comfort", "BC City+", "BC Lite"];

// Bump this whenever the demo geography/seed data changes so existing
// prototype databases get refreshed automatically on next startup
// (MVP demo data — safe to wipe & reseed, no real user data).
const DEMO_DATA_VERSION = 3;

// Demo fleet size — kept small (a handful of sample bikes) so QR/rental flow
// and admin tables have data without flooding the map/tables with 100 bikes.
const DEMO_BIKE_COUNT = 5;

// ---------- Demo data migration (MVP prototype only) ----------
//
// Older prototype DBs were seeded with Kaliningrad demo parkings. The map was
// refocused on the Baltic coastal towns (Светлогорск / Пионерский /
// Зеленоградск), so an existing DB must be refreshed to the new demo data.
// We persist a version marker; if it's missing or stale (or we detect the old
// parking layout), we clear and reseed all demo tables. This avoids manual SSH.
function migrateDemoData() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = sqlite.prepare("SELECT value FROM meta WHERE key = 'demo_data_version'").get() as
    | { value: string }
    | undefined;
  const storedVersion = row ? parseInt(row.value, 10) : 0;

  // Detect legacy data: any parking whose name doesn't belong to the current
  // coastal towns indicates an old (e.g. Kaliningrad) seed.
  const coastalTowns = ["Светлогорск", "Пионерский", "Зеленоградск"];
  const parkingCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM parkings").get() as { c: number }).c;
  let hasLegacyParkings = false;
  if (parkingCount > 0) {
    const names = sqlite.prepare("SELECT name FROM parkings").all() as { name: string }[];
    hasLegacyParkings = names.some((p) => !coastalTowns.some((t) => p.name.includes(t)));
  }

  const needsReseed = storedVersion < DEMO_DATA_VERSION || hasLegacyParkings;
  if (!needsReseed) return;

  // Refresh demo data without destroying operator-added real bikes. Only rows
  // that belong to the demo seed are cleared; manually-added bikes (seed = 0)
  // and any rides/tickets referencing them are preserved. Wrapped in a
  // transaction so startup sees either the old or the fully refreshed state.
  const reset = sqlite.transaction(() => {
    // Demo rides/tickets reference demo (seed) bikes only. Clear those, plus the
    // wider demo payments/wallet/zones/parkings which carry no manual data.
    sqlite.exec(`
      DELETE FROM ticket_comments WHERE ticket_id IN (
        SELECT id FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = 1)
      );
      DELETE FROM rides   WHERE bike_id IN (SELECT id FROM bikes WHERE seed = 1);
      DELETE FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = 1);
      DELETE FROM payments;
      DELETE FROM wallet;
      DELETE FROM zones;
      DELETE FROM parkings;
      DELETE FROM bikes   WHERE seed = 1;
    `);
    // Reset AUTOINCREMENT counters for tickets/payments if present. `rides` is
    // intentionally left so ids stay stable for any preserved manual-bike rides.
    try {
      sqlite.exec("DELETE FROM sqlite_sequence WHERE name IN ('tickets','ticket_comments','payments')");
    } catch {
      // sqlite_sequence only exists once an AUTOINCREMENT table has rows; ignore.
    }
    populateDemoData();
    sqlite
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_data_version', ?)")
      .run(String(DEMO_DATA_VERSION));
  });
  reset();
}

function seedRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function populateDemoData() {
  const rng = seedRng(20260525);
  const now = Date.now();

  // Bikes — a small sample fleet placed near parkings. All seeded as
  // "available" with healthy batteries so the QR/rental demo flow always has a
  // bike to pick, while still giving admin tables real sample rows.
  const insertBike = sqlite.prepare(
    `INSERT INTO bikes (id, model, status, battery, lat, lng, last_seen, idle_hours, flagged, parking_id, seed)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`
  );
  for (let i = 1; i <= DEMO_BIKE_COUNT; i++) {
    const id = `BC-${String(i).padStart(3, "0")}`;
    const model = MODELS[i % MODELS.length];
    const p = PARKINGS[i % PARKINGS.length];
    const x = p.x + (rng() - 0.5) * 18;
    const y = p.y + (rng() - 0.5) * 18;

    const battery = Math.max(45, Math.min(100, Math.round(60 + rng() * 40)));
    const idleHours = +(rng() * 6).toFixed(1);
    const status = "available";
    const flagged = 0;
    const lastSeen = now - Math.round(idleHours * 3600 * 1000);

    insertBike.run(id, model, status, battery, y, x, lastSeen, idleHours, flagged, p.id);
  }

  // Parkings
  const insertP = sqlite.prepare("INSERT INTO parkings VALUES (?,?,?,?,?,?)");
  for (const p of PARKINGS) {
    const occupied = Math.min(p.capacity, Math.floor(rng() * p.capacity * 0.9));
    insertP.run(p.id, p.name, p.y, p.x, p.capacity, occupied);
  }

  // Zones
  const insertZ = sqlite.prepare("INSERT INTO zones VALUES (?,?,?,?)");
  insertZ.run("Z-OP", "Зона обслуживания побережья", "operating", JSON.stringify(OPERATING_ZONE));
  for (const s of SLOW_ZONES) insertZ.run(s.id, s.name, "slow", JSON.stringify(s.polygon));
  for (const f of FORBIDDEN_ZONES) insertZ.run(f.id, f.name, "forbidden", JSON.stringify(f.polygon));

  // Wallet — single demo user (seeded with a top-up so MVP can be exercised immediately)
  sqlite.prepare(
    "INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at) VALUES ('demo', 500, 'payg', NULL)"
  ).run();

  // Seed a couple of maintenance tickets against existing sample bikes so the
  // admin tickets table has data without referencing bikes that no longer exist.
  const sampleBikeIds = sqlite.prepare("SELECT id FROM bikes ORDER BY id").all() as { id: string }[];
  const insertT = sqlite.prepare(
    "INSERT INTO tickets (bike_id, kind, priority, title, message, assignee, status, created_at, updated_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  if (sampleBikeIds[0]) insertT.run(sampleBikeIds[0].id, "wheel_puncture", "high", "Спущено колесо", "Пользователь сообщил: спущено заднее колесо", null, "new", now - 5400000, null, null);
  if (sampleBikeIds[1]) insertT.run(sampleBikeIds[1].id, "lock", "critical", "Не фиксируется замок", "Пользователь сообщил: не фиксируется замок", "Сервисная бригада", "in_progress", now - 86400000, now - 80000000, null);
  if (sampleBikeIds[2]) insertT.run(sampleBikeIds[2].id, "dirty", "low", "Грязный велосипед", "Требуется мойка после поездки в дождь", null, "resolved", now - 172800000, now - 90000000, now - 90000000);

  // Seed some past payments and rides to give analytics a baseline
  const insertPay = sqlite.prepare("INSERT INTO payments (user_id, amount, kind, description, created_at) VALUES (?,?,?,?,?)");
  insertPay.run("demo", 500, "topup", "Пополнение через банковскую карту •• 4242", now - 86400000 * 6);

  const insertR = sqlite.prepare(
    "INSERT INTO rides (bike_id, user_id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng, track, distance_m, cost, tariff, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const rideUsers = ["demo", "user-2", "user-3", "user-4", "user-5"];
  for (let i = 0; i < 240; i++) {
    const bikeIdx = 1 + Math.floor(rng() * DEMO_BIKE_COUNT);
    const bikeId = `BC-${String(bikeIdx).padStart(3, "0")}`;
    const user = rideUsers[Math.floor(rng() * rideUsers.length)];
    const daysAgo = Math.floor(rng() * 28);
    const startedAt = now - daysAgo * 86400000 - Math.floor(rng() * 86400000);
    const duration = Math.floor(180000 + rng() * 1800000); // 3–33 min
    const endedAt = startedAt + duration;
    const sp = PARKINGS[Math.floor(rng() * PARKINGS.length)];
    const ep = PARKINGS[Math.floor(rng() * PARKINGS.length)];
    const trackPts: [number, number, number][] = [];
    const steps = 8;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = sp.x + (ep.x - sp.x) * t + (rng() - 0.5) * 14;
      const y = sp.y + (ep.y - sp.y) * t + (rng() - 0.5) * 14;
      trackPts.push([x, y, startedAt + (duration * t)]);
    }
    const distance = Math.floor(800 + rng() * 5200);
    const minutes = duration / 60000;
    const cost = Math.round(50 + minutes * 6);
    insertR.run(
      bikeId, user, startedAt, endedAt,
      sp.y, sp.x, ep.y, ep.x,
      JSON.stringify(trackPts), distance, cost, "payg", "completed",
    );
  }
}

// On a fresh DB, seed once and record the current demo data version.
// On an existing DB, migrate/refresh stale or legacy (Kaliningrad) demo data.
function bootstrapDemoData() {
  const count = sqlite.prepare("SELECT COUNT(*) AS c FROM bikes").get() as { c: number };
  if (count.c === 0) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    populateDemoData();
    sqlite
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_data_version', ?)")
      .run(String(DEMO_DATA_VERSION));
    return;
  }
  migrateDemoData();
}
bootstrapDemoData();

// ---------- Storage interface ----------

// Normalize a user-entered phone to a storable canonical form: keep digits and
// a single optional leading "+". A Russian "8XXXXXXXXXX" national number is
// converted to "+7XXXXXXXXXX" so duplicates and display stay consistent.
// ---------- OTP policy ----------
export const OTP_TTL_MS = 5 * 60 * 1000;     // code valid 5 minutes
export const OTP_MAX_ATTEMPTS = 5;           // wrong-code tries before lockout
export const OTP_RESEND_LOCK_MS = 60 * 1000; // min seconds between SMS per phone

// Secret used to HMAC the OTP before storage. Falls back to the session secret
// (or a dev constant) so codes are never persisted in plaintext even locally.
function otpSecret(): string {
  return process.env.OTP_SECRET || process.env.SESSION_SECRET || "baltcircle-dev-otp-secret";
}

function hashOtp(phone: string, code: string): string {
  // Bind the hash to the phone so a leaked hash can't be replayed against
  // another number, and so identical codes for different phones differ.
  return createHmac("sha256", otpSecret()).update(`${phone}:${code}`).digest("hex");
}

function generateOtp(): string {
  // 4-digit numeric code (1000–9999) — matches the SMS copy and UI input.
  return String(randomInt(1000, 10000));
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!hasPlus && digits.length === 11 && digits.startsWith("8")) {
    digits = "7" + digits.slice(1);
    return "+" + digits;
  }
  return hasPlus ? "+" + digits : digits;
}

// Temporary admin bootstrap. ADMIN_PHONE_NUMBERS is a comma-separated list of
// phone numbers (any format) that should be granted the admin role. Nothing is
// hardcoded: with the env unset the set is empty and no one is auto-promoted.
// Each entry is normalized the same way rider phones are, so "8…" / "+7…" /
// spaced forms all match. This is a stopgap until a proper role-admin UI exists.
function adminPhoneSet(): Set<string> {
  const raw = process.env.ADMIN_PHONE_NUMBERS || "";
  return new Set(
    raw
      .split(",")
      .map((p) => normalizePhone(p))
      .filter((p) => p.replace(/\D/g, "").length >= 10),
  );
}

export function isAdminPhone(phone: string): boolean {
  return adminPhoneSet().has(normalizePhone(phone));
}

// Resolve the role a user should currently have. The ADMIN_PHONE_NUMBERS env
// takes precedence so a phone added to the list is promoted on next lookup even
// if the stored row predates the list; otherwise the persisted role is used.
export function resolveRole(user: User): UserRole {
  if (isAdminPhone(user.phone)) return "admin";
  return (user.role as UserRole) ?? "rider";
}

export interface IStorage {
  // users
  getUser(id: string): User | undefined;
  getUserByPhone(phone: string): User | undefined;
  updateProfile(id: string, patch: UpdateProfileInput): { user: User } | { error: string };
  // admin user management
  listUsers(): User[];
  setUserRole(id: string, role: UserRole): { user: User } | { error: string };
  setUserBlocked(id: string, blocked: boolean, reason?: string): { user: User } | { error: string };
  // OTP verification
  startOtp(input: { name: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyOtp(input: { phone: string; code: string; consentIp?: string }): { user: User } | { error: string };
  // phone change (SMS OTP for an existing account)
  startPhoneChange(input: { userId: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyPhoneChange(input: { userId: string; code: string }): { user: User } | { error: string };
  // payment methods (MVP metadata only — no card data)
  listPaymentMethods(userId: string): PaymentMethod[];
  linkPaymentMethod(userId: string, type: "card" | "sbp"): PaymentMethod;
  unlinkPaymentMethod(userId: string, id: number): boolean;
  // support tickets (rider help requests)
  listSupportTickets(userId: string): SupportTicket[];
  createSupportTicket(input: { userId: string; subject: string; message: string }): SupportTicket;
  // bikes
  listBikes(opts?: { includeArchived?: boolean }): Bike[];
  getBike(id: string): Bike | undefined;
  updateBike(id: string, patch: Partial<Bike>): Bike | undefined;
  // bikes — admin CRUD (staff only)
  createBike(input: AdminCreateBikeInput): { bike: Bike } | { error: string };
  adminUpdateBike(id: string, patch: AdminUpdateBikeInput): { bike: Bike } | { error: string };
  archiveBike(id: string): { bike: Bike } | { error: string };
  deleteBike(id: string): { ok: true } | { error: string; archived?: Bike };
  // parkings
  listParkings(): Parking[];
  // zones
  listZones(): ZoneRow[];
  // rides
  startRide(input: { bikeId: string; userId: string; tariff: string }): Ride | { error: string };
  appendRidePoint(rideId: number, x: number, y: number): Ride | undefined;
  endRide(rideId: number): Ride | undefined;
  getActiveRide(userId: string): Ride | undefined;
  listRides(opts?: { userId?: string; limit?: number }): Ride[];
  listAdminRides(opts?: { limit?: number }): AdminRide[];
  // payments / wallet
  getWallet(userId: string): Wallet;
  topUp(userId: string, amount: number): { wallet: Wallet; payment: Payment };
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number): { wallet: Wallet; payment: Payment };
  listPayments(userId: string): Payment[];
  // service / maintenance tickets
  listTickets(): Ticket[];
  getTicket(id: number): TicketWithComments | undefined;
  createTicket(input: CreateTicketInput): TicketWithComments;
  updateTicket(id: number, patch: UpdateTicketInput, actor: string): TicketWithComments | undefined;
  addTicketComment(id: number, author: string, body: string): TicketWithComments | undefined;
  // map objects (operator-drawn routes/zones)
  listMapObjects(): MapObject[];
  createMapObject(input: InsertMapObject): MapObject;
  deleteMapObject(id: number): boolean;
  // analytics
  analytics(): any;
}

export class DatabaseStorage implements IStorage {
  // Apply the env-driven admin override so callers always see the effective
  // role without each one re-checking ADMIN_PHONE_NUMBERS.
  private withResolvedRole(user: User | undefined): User | undefined {
    if (!user) return user;
    return { ...user, role: resolveRole(user) };
  }

  getUser(id: string) {
    const u = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    return this.withResolvedRole(u);
  }

  getUserByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    const u = db.select().from(users).where(eq(users.phone, normalized)).get() as User | undefined;
    return this.withResolvedRole(u);
  }

  // Self-service profile update for the current user. Only name/email are
  // mutable here; phone changes must go through SMS OTP (not this endpoint).
  updateProfile(id: string, patch: UpdateProfileInput) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };

    const set: Partial<User> = { updatedAt: Date.now() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.email !== undefined) {
      const email = patch.email.trim();
      set.email = email.length > 0 ? email : null;
    }
    db.update(users).set(set as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  // ---------- Admin user management ----------
  // List every registered user, newest first, with effective roles applied so
  // the admin table shows the same role the rest of the app enforces (the
  // ADMIN_PHONE_NUMBERS override can make a stored "rider" effectively admin).
  listUsers() {
    const rows = db.select().from(users).orderBy(desc(users.createdAt)).all() as User[];
    return rows.map((u) => this.withResolvedRole(u)!);
  }

  setUserRole(id: string, role: UserRole) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    db.update(users).set({ role, updatedAt: Date.now() } as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  setUserBlocked(id: string, blocked: boolean, reason?: string) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    const set: Partial<User> = {
      blockedAt: blocked ? Date.now() : null,
      blockedReason: blocked ? (reason?.trim() || null) : null,
      updatedAt: Date.now(),
    };
    db.update(users).set(set as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  // ---------- OTP verification ----------
  // Step 1: create/refresh a pending code for this phone and hand the plaintext
  // back to the caller so it can be dispatched via SMS. The code itself is only
  // stored as an HMAC. Enforces a per-phone resend lock.
  startOtp({ name, phone }: { name: string; phone: string }) {
    const cleanName = name.trim();
    const cleanPhone = normalizePhone(phone);
    const digits = cleanPhone.replace(/\D/g, "");
    if (cleanName.length < 2) return { error: "Имя должно содержать минимум 2 символа" };
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };

    const now = Date.now();
    const existing = db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;

    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return {
          error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`,
          retryAfterSec,
        };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(cleanPhone, code);
    const expiresAt = now + OTP_TTL_MS;

    db.insert(otpRequests)
      .values({ phone: cleanPhone, name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: otpRequests.phone,
        set: { name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      })
      .run();

    return { ok: true as const, phone: cleanPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify a submitted code. On success the rider is created (or reused
  // if the phone already registered) and the request row is consumed.
  verifyOtp({ phone, code, consentIp }: { phone: string; code: string; consentIp?: string }) {
    const cleanPhone = normalizePhone(phone);
    const req = db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;

    if (!req || req.consumed) {
      return { error: "Запросите код подтверждения заново" };
    }
    if (Date.now() > req.expiresAt) {
      return { error: "Срок действия кода истёк. Запросите новый код" };
    }
    if (req.attempts >= OTP_MAX_ATTEMPTS) {
      return { error: "Слишком много попыток. Запросите новый код" };
    }

    const expected = req.codeHash;
    const provided = hashOtp(cleanPhone, code.trim());
    if (!safeEqualHex(provided, expected)) {
      const attempts = req.attempts + 1;
      db.update(otpRequests).set({ attempts }).where(eq(otpRequests.phone, cleanPhone)).run();
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Correct code — consume the request so it can't be reused.
    db.update(otpRequests).set({ consumed: true }).where(eq(otpRequests.phone, cleanPhone)).run();

    // Consent was accepted at OTP start (the API requires consent: true before
    // a code is sent), so record the consent metadata on verify when the rider
    // row is created/refreshed. The verified phone IS the proof of consent.
    const now = Date.now();
    const role: UserRole = isAdminPhone(cleanPhone) ? "admin" : "rider";

    // Reuse an existing rider for this phone (keeps rides/wallet) or create one.
    const existing = db.select().from(users).where(eq(users.phone, cleanPhone)).get() as
      | User
      | undefined;
    if (existing) {
      const set: Partial<User> = {
        updatedAt: now,
        consentAcceptedAt: now,
        consentVersion: CONSENT_VERSION,
        consentIp: consentIp ?? existing.consentIp ?? null,
        // Keep an already-elevated role (e.g. operator) but ensure admin phones
        // are promoted. Never silently demote a stored operator/admin.
        role: role === "admin" ? "admin" : (existing.role as UserRole),
      };
      if (existing.name !== req.name) set.name = req.name;
      db.update(users).set(set as any).where(eq(users.id, existing.id)).run();
      return { user: this.getUser(existing.id)! };
    }
    db.insert(users).values({
      id: randomUUID(),
      name: req.name,
      phone: cleanPhone,
      email: null,
      role,
      consentAcceptedAt: now,
      consentVersion: CONSENT_VERSION,
      consentIp: consentIp ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).run();
    return { user: this.getUserByPhone(cleanPhone)! };
  }

  // ---------- Phone change (SMS OTP, existing account) ----------
  // Step 1: a logged-in rider requests a code sent to a NEW number. The pending
  // request is keyed by the user id and stores the target phone; the code is
  // stored only as an HMAC. Enforces the same per-request resend lock as
  // registration and refuses a number already used by another account.
  startPhoneChange({ userId, phone }: { userId: string; phone: string }) {
    const user = db.select().from(users).where(eq(users.id, userId)).get() as User | undefined;
    if (!user) return { error: "Пользователь не найден" };

    const newPhone = normalizePhone(phone);
    const digits = newPhone.replace(/\D/g, "");
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };
    if (newPhone === user.phone) return { error: "Это уже ваш текущий номер" };

    // Don't allow merging into another account's number.
    const taken = db.select().from(users).where(eq(users.phone, newPhone)).get() as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    const now = Date.now();
    const existing = db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).get() as PhoneChangeRequest | undefined;
    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return { error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`, retryAfterSec };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(newPhone, code);
    const expiresAt = now + OTP_TTL_MS;
    db.insert(phoneChangeRequests)
      .values({ userId, newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: phoneChangeRequests.userId,
        set: { newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      })
      .run();

    return { ok: true as const, phone: newPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify the code sent to the new number and, on success, update the
  // user's phone. The request row is consumed so the code can't be reused.
  verifyPhoneChange({ userId, code }: { userId: string; code: string }) {
    const req = db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).get() as PhoneChangeRequest | undefined;
    if (!req || req.consumed) return { error: "Запросите код подтверждения заново" };
    if (Date.now() > req.expiresAt) return { error: "Срок действия кода истёк. Запросите новый код" };
    if (req.attempts >= OTP_MAX_ATTEMPTS) return { error: "Слишком много попыток. Запросите новый код" };

    const provided = hashOtp(req.newPhone, code.trim());
    if (!safeEqualHex(provided, req.codeHash)) {
      const attempts = req.attempts + 1;
      db.update(phoneChangeRequests).set({ attempts }).where(eq(phoneChangeRequests.userId, userId)).run();
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Re-check the number is still free (another account could have claimed it
    // between request and verify), then apply the change.
    const taken = db.select().from(users).where(eq(users.phone, req.newPhone)).get() as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    db.update(phoneChangeRequests).set({ consumed: true }).where(eq(phoneChangeRequests.userId, userId)).run();
    db.update(users).set({ phone: req.newPhone, updatedAt: Date.now() } as any).where(eq(users.id, userId)).run();
    return { user: this.getUser(userId)! };
  }

  // ---------- Payment methods (MVP metadata only) ----------
  listPaymentMethods(userId: string) {
    return db.select().from(paymentMethods)
      .where(eq(paymentMethods.userId, userId))
      .orderBy(desc(paymentMethods.createdAt))
      .all() as PaymentMethod[];
  }

  // Link a method. Label/status are derived server-side so no card data can be
  // injected via the client. A masked test pan is used for "card" — never a
  // real number — and a fixed label for SBP.
  linkPaymentMethod(userId: string, type: "card" | "sbp") {
    const label = type === "card" ? "•••• 4242" : "СБП";
    return db.insert(paymentMethods).values({
      userId, type, label, status: "linked", createdAt: Date.now(),
    }).returning().get() as PaymentMethod;
  }

  unlinkPaymentMethod(userId: string, id: number) {
    const res = db.delete(paymentMethods)
      .where(sql`${paymentMethods.id} = ${id} AND ${paymentMethods.userId} = ${userId}`)
      .run();
    return res.changes > 0;
  }

  // ---------- Support tickets ----------
  listSupportTickets(userId: string) {
    return db.select().from(supportTickets)
      .where(eq(supportTickets.userId, userId))
      .orderBy(desc(supportTickets.createdAt))
      .all() as SupportTicket[];
  }

  createSupportTicket({ userId, subject, message }: { userId: string; subject: string; message: string }) {
    return db.insert(supportTickets).values({
      userId, subject: subject.trim(), message: message.trim(), status: "open", createdAt: Date.now(),
    }).returning().get() as SupportTicket;
  }

  // Public list excludes archived (retired) bikes so they never appear on the
  // map or in rental selection. Admin callers pass includeArchived to see all.
  listBikes(opts?: { includeArchived?: boolean }) {
    const rows = db.select().from(bikes).all() as Bike[];
    if (opts?.includeArchived) return rows;
    return rows.filter((b) => b.status !== "archived");
  }
  getBike(id: string) { return db.select().from(bikes).where(eq(bikes.id, id)).get() as Bike | undefined; }
  updateBike(id: string, patch: Partial<Bike>) {
    db.update(bikes).set(patch as any).where(eq(bikes.id, id)).run();
    return this.getBike(id);
  }

  // ---------- Bikes: admin CRUD (staff only) ----------
  // Normalize an optional string field: trim, and treat "" as null so blank
  // form inputs clear the column rather than storing an empty string.
  private optStr(v: string | undefined): string | null {
    if (v === undefined) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  }

  // Create a real (non-demo) bike. The id is unique (primary key); a duplicate
  // is rejected with a clear message. Map coordinates default to the assigned
  // parking station or the map centre so the bike has a valid position.
  createBike(input: AdminCreateBikeInput) {
    const id = input.id.trim().toUpperCase();
    if (this.getBike(id)) return { error: "Велосипед с таким кодом уже существует" };

    let lat = MAP_H / 2;
    let lng = MAP_W / 2;
    const parkingId = this.optStr(input.parkingId);
    if (parkingId) {
      const p = db.select().from(parkings).where(eq(parkings.id, parkingId)).get() as Parking | undefined;
      if (p) { lat = p.lat; lng = p.lng; }
    }

    const now = Date.now();
    db.insert(bikes).values({
      id,
      model: input.model.trim(),
      status: input.status,
      battery: input.battery,
      lat, lng,
      lastSeen: now,
      idleHours: 0,
      flagged: false,
      serial: this.optStr(input.serial),
      lockId: this.optStr(input.lockId),
      parkingId,
      notes: this.optStr(input.notes),
      seed: false,
    } as any).run();
    return { bike: this.getBike(id)! };
  }

  adminUpdateBike(id: string, patch: AdminUpdateBikeInput) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };

    const set: Partial<Bike> = {};
    if (patch.model !== undefined) set.model = patch.model.trim();
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.battery !== undefined) set.battery = patch.battery;
    if (patch.serial !== undefined) set.serial = this.optStr(patch.serial);
    if (patch.lockId !== undefined) set.lockId = this.optStr(patch.lockId);
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
    if (patch.parkingId !== undefined) {
      const parkingId = this.optStr(patch.parkingId);
      set.parkingId = parkingId;
    }
    db.update(bikes).set(set as any).where(eq(bikes.id, id)).run();
    return { bike: this.getBike(id)! };
  }

  // Soft delete: mark a bike archived so it drops out of the public list and
  // rental selection while keeping its ride history intact.
  archiveBike(id: string) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя архивировать велосипед во время активной аренды" };
    db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id)).run();
    return { bike: this.getBike(id)! };
  }

  // Hard delete: only allowed when the bike has no ride history. Otherwise we
  // refuse and archive instead, so analytics/ride records never dangle.
  deleteBike(id: string) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя удалить велосипед во время активной аренды" };
    const rideCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides WHERE bike_id = ?").get(id) as { c: number }).c;
    if (rideCount > 0) {
      db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id)).run();
      return { error: "У велосипеда есть история поездок — он переведён в архив", archived: this.getBike(id)! };
    }
    db.delete(bikes).where(eq(bikes.id, id)).run();
    return { ok: true as const };
  }
  listParkings() { return db.select().from(parkings).all() as Parking[]; }
  listZones() { return db.select().from(zones).all() as ZoneRow[]; }

  startRide({ bikeId, userId, tariff }: { bikeId: string; userId: string; tariff: string }) {
    const bike = this.getBike(bikeId);
    if (!bike) return { error: "Велосипед не найден" };
    if (bike.status !== "available" && bike.status !== "reserved") {
      return { error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` };
    }
    if (bike.battery < 18) return { error: "Низкий заряд замка, выберите другой велосипед" };
    const active = this.getActiveRide(userId);
    if (active) return { error: "У вас уже есть активная поездка" };

    const startedAt = Date.now();
    const track: [number, number, number][] = [[bike.lng, bike.lat, startedAt]];
    const row = db.insert(rides).values({
      bikeId, userId, startedAt,
      startLat: bike.lat, startLng: bike.lng,
      track: JSON.stringify(track), distanceM: 0, cost: 0, tariff, status: "active",
    }).returning().get() as Ride;
    this.updateBike(bikeId, { status: "rented" });
    return row;
  }

  appendRidePoint(rideId: number, x: number, y: number) {
    const r = db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
    if (!r || r.status !== "active") return undefined;
    const pts: [number, number, number][] = JSON.parse(r.track);
    const last = pts[pts.length - 1];
    const dx = x - last[0], dy = y - last[1];
    const dMap = Math.sqrt(dx * dx + dy * dy);
    // 1 map unit ≈ 30 metres (≈30km coastal span across 1000 units, demo scale)
    const addedMeters = dMap * 30;
    pts.push([x, y, Date.now()]);
    const newDistance = r.distanceM + addedMeters;
    const minutes = (Date.now() - r.startedAt) / 60000;
    const newCost = Math.max(50, Math.round(50 + minutes * 6));
    db.update(rides).set({
      track: JSON.stringify(pts), distanceM: newDistance, cost: newCost,
    }).where(eq(rides.id, rideId)).run();
    db.update(bikes).set({ lat: y, lng: x, lastSeen: Date.now(), idleHours: 0 } as any)
      .where(eq(bikes.id, r.bikeId)).run();
    return db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride;
  }

  endRide(rideId: number) {
    const r = db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
    if (!r || r.status !== "active") return undefined;
    const pts: [number, number, number][] = JSON.parse(r.track);
    const last = pts[pts.length - 1];
    const endedAt = Date.now();
    const minutes = (endedAt - r.startedAt) / 60000;
    const cost = Math.max(50, Math.round(50 + minutes * 6));
    db.update(rides).set({
      endedAt, status: "completed", cost,
      endLat: last[1], endLng: last[0],
    }).where(eq(rides.id, rideId)).run();
    db.update(bikes).set({ status: "available", lat: last[1], lng: last[0], lastSeen: endedAt, idleHours: 0 } as any)
      .where(eq(bikes.id, r.bikeId)).run();
    // charge wallet
    const w = this.getWallet(r.userId);
    const newBalance = w.balance - cost;
    db.update(wallet).set({ balance: newBalance }).where(eq(wallet.userId, r.userId)).run();
    db.insert(payments).values({
      userId: r.userId, amount: -cost, kind: "ride_charge",
      description: `Поездка ${r.bikeId} • ${Math.round(minutes)} мин`, createdAt: endedAt,
    }).run();
    return db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride;
  }

  getActiveRide(userId: string) {
    return db.select().from(rides)
      .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
      .get() as Ride | undefined;
  }

  listRides(opts?: { userId?: string; limit?: number }) {
    const limit = opts?.limit ?? 50;
    if (opts?.userId) {
      return db.select().from(rides)
        .where(eq(rides.userId, opts.userId))
        .orderBy(desc(rides.startedAt))
        .limit(limit)
        .all() as Ride[];
    }
    return db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).all() as Ride[];
  }

  // Rides for the operator panel, newest first, joined to rider identity so the
  // admin table can show a name/phone instead of a raw user id. Riders are
  // looked up in a single batch; unknown/demo ids resolve to null so the UI can
  // fall back to the id.
  listAdminRides(opts?: { limit?: number }) {
    const limit = opts?.limit ?? 200;
    const rows = db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).all() as Ride[];
    const all = db.select().from(users).all() as User[];
    const byId = new Map(all.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.userId);
      return { ...r, userName: u?.name ?? null, userPhone: u?.phone ?? null } as AdminRide;
    });
  }

  getWallet(userId: string) {
    let w = db.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet | undefined;
    if (!w) {
      db.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
      w = db.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet;
    }
    return w;
  }

  topUp(userId: string, amount: number) {
    const w = this.getWallet(userId);
    const newBal = w.balance + amount;
    db.update(wallet).set({ balance: newBal }).where(eq(wallet.userId, userId)).run();
    const pay = db.insert(payments).values({
      userId, amount, kind: "topup",
      description: `Пополнение баланса карты •• 4242`, createdAt: Date.now(),
    }).returning().get() as Payment;
    return { wallet: this.getWallet(userId), payment: pay };
  }

  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number) {
    const w = this.getWallet(userId);
    const newBal = w.balance - price;
    const expires = Date.now() + durationMs;
    db.update(wallet).set({ balance: newBal, activeTariff: tariff, tariffExpiresAt: expires } as any)
      .where(eq(wallet.userId, userId)).run();
    const pay = db.insert(payments).values({
      userId, amount: -price, kind: "tariff_purchase",
      description: `Подключён тариф «${tariff}»`, createdAt: Date.now(),
    }).returning().get() as Payment;
    return { wallet: this.getWallet(userId), payment: pay };
  }

  listPayments(userId: string) {
    return db.select().from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt))
      .all() as Payment[];
  }

  listTickets() { return db.select().from(tickets).orderBy(desc(tickets.createdAt)).all() as Ticket[]; }

  getTicket(id: number): TicketWithComments | undefined {
    const t = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!t) return undefined;
    const comments = db.select().from(ticketComments)
      .where(eq(ticketComments.ticketId, id))
      .orderBy(ticketComments.createdAt)
      .all() as TicketComment[];
    return { ...t, comments };
  }

  private addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event") {
    db.insert(ticketComments).values({
      ticketId, author, body, kind, createdAt: Date.now(),
    }).run();
  }

  createTicket(input: CreateTicketInput): TicketWithComments {
    const now = Date.now();
    const title = (input.title ?? "").trim();
    const assignee = (input.assignee ?? "").trim();
    const row = db.insert(tickets).values({
      bikeId: input.bikeId,
      kind: input.kind,
      priority: input.priority,
      title,
      message: input.message,
      assignee: assignee || null,
      status: "new",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    }).returning().get() as Ticket;
    this.addEvent(row.id, "Система", "Заявка создана", "event");

    // High/critical tickets pull a rentable bike out of rotation into
    // maintenance so it can't be rented while the issue is open. We never touch
    // a bike that's mid-ride (rented) or already out of service.
    if ((input.priority === "high" || input.priority === "critical")) {
      const bike = this.getBike(input.bikeId);
      if (bike && (bike.status === "available" || bike.status === "reserved")) {
        this.updateBike(bike.id, { status: "maintenance" });
        this.addEvent(row.id, "Система", `Велосипед ${bike.id} переведён в обслуживание`, "event");
      }
    }
    return this.getTicket(row.id)!;
  }

  updateTicket(id: number, patch: UpdateTicketInput, actor: string): TicketWithComments | undefined {
    const existing = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!existing) return undefined;
    const now = Date.now();
    const set: Partial<Ticket> = { updatedAt: now };

    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      set.priority = patch.priority;
      this.addEvent(id, actor, `Приоритет: ${existing.priority} → ${patch.priority}`, "event");
    }
    if (patch.assignee !== undefined) {
      const next = patch.assignee.trim() || null;
      if (next !== (existing.assignee ?? null)) {
        set.assignee = next;
        this.addEvent(id, actor, next ? `Назначено: ${next}` : "Исполнитель снят", "event");
      }
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      set.status = patch.status;
      const becameClosed = TICKET_CLOSED_STATUSES.includes(patch.status);
      set.closedAt = becameClosed ? now : null;
      this.addEvent(id, actor, `Статус: ${existing.status} → ${patch.status}`, "event");
    }

    db.update(tickets).set(set as any).where(eq(tickets.id, id)).run();

    // Optional action when closing: return the bike to the rental pool if it's
    // currently in maintenance because of this issue.
    if (patch.returnBikeToAvailable) {
      const bike = this.getBike(existing.bikeId);
      if (bike && bike.status === "maintenance") {
        this.updateBike(bike.id, { status: "available" });
        this.addEvent(id, actor, `Велосипед ${bike.id} возвращён в доступные`, "event");
      }
    }
    return this.getTicket(id);
  }

  addTicketComment(id: number, author: string, body: string): TicketWithComments | undefined {
    const existing = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!existing) return undefined;
    this.addEvent(id, author, body, "comment");
    db.update(tickets).set({ updatedAt: Date.now() }).where(eq(tickets.id, id)).run();
    return this.getTicket(id);
  }

  listMapObjects() {
    return db.select().from(mapObjects).orderBy(desc(mapObjects.createdAt)).all() as MapObject[];
  }

  createMapObject(input: InsertMapObject) {
    return db.insert(mapObjects).values({
      name: input.name,
      type: input.type,
      kind: input.kind,
      color: input.color,
      points: JSON.stringify(input.points),
      createdAt: Date.now(),
    }).returning().get() as MapObject;
  }

  deleteMapObject(id: number) {
    const res = db.delete(mapObjects).where(eq(mapObjects.id, id)).run();
    return res.changes > 0;
  }

  analytics() {
    const total = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides").get() as any).c;
    const completed = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides WHERE status='completed'").get() as any).c;
    const revenue = (sqlite.prepare("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed'").get() as any).s;
    const avgDuration = (sqlite.prepare("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed'").get() as any).a;
    const avgDistance = (sqlite.prepare("SELECT COALESCE(AVG(distance_m),0) AS a FROM rides WHERE status='completed'").get() as any).a;

    const byDay = sqlite.prepare(`
      SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(cost),0) AS revenue
      FROM rides
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `).all().reverse();

    // popular parkings — proximity of ride start
    const allParkings = this.listParkings();
    const allRides = sqlite.prepare("SELECT start_lat, start_lng FROM rides").all() as any[];
    const parkingCounts = allParkings.map(p => {
      let c = 0;
      for (const r of allRides) {
        const dx = r.start_lng - p.lng;
        const dy = r.start_lat - p.lat;
        if (Math.sqrt(dx*dx+dy*dy) < 30) c++;
      }
      return { ...p, rideStarts: c };
    }).sort((a, b) => b.rideStarts - a.rideStarts);

    const utilisation = sqlite.prepare(`
      SELECT bike_id, COUNT(*) AS rides
      FROM rides
      GROUP BY bike_id
      ORDER BY rides DESC
      LIMIT 8
    `).all();

    const problemBikes = sqlite.prepare(`
      SELECT * FROM bikes
      WHERE flagged = 1 OR battery < 25 OR idle_hours > 60
      ORDER BY idle_hours DESC
      LIMIT 12
    `).all();

    const idleAvg = (sqlite.prepare("SELECT AVG(idle_hours) AS a FROM bikes").get() as any).a;

    return { total, completed, revenue, avgDuration, avgDistance, byDay, parkingCounts, utilisation, problemBikes, idleAvg };
  }
}

export const storage = new DatabaseStorage();
