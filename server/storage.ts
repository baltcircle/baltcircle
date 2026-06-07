import {
  bikes, parkings, zones, rides, tickets, payments, wallet, mapObjects, users,
  otpRequests,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, Ticket, Payment, Wallet,
  MapObject, InsertMapObject, User, OtpRequest, UserRole, UpdateProfileInput,
} from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES,
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
  flagged INTEGER NOT NULL DEFAULT 0
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
  message TEXT NOT NULL,
  status TEXT NOT NULL,
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
  addColumn("updated_at", "updated_at INTEGER");
}
migrateUsersTable();

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

  // Wipe demo tables and reseed. Wrapped in a transaction so startup either
  // sees the old data or the fully refreshed data, never a partial state.
  const reset = sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM rides;
      DELETE FROM tickets;
      DELETE FROM payments;
      DELETE FROM wallet;
      DELETE FROM zones;
      DELETE FROM parkings;
      DELETE FROM bikes;
    `);
    // Reset AUTOINCREMENT counters for rides/tickets/payments if present.
    try {
      sqlite.exec("DELETE FROM sqlite_sequence WHERE name IN ('rides','tickets','payments')");
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
    "INSERT INTO bikes VALUES (?,?,?,?,?,?,?,?,?)"
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

    insertBike.run(id, model, status, battery, y, x, lastSeen, idleHours, flagged);
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
  const insertT = sqlite.prepare("INSERT INTO tickets (bike_id, kind, message, status, created_at) VALUES (?,?,?,?,?)");
  if (sampleBikeIds[0]) insertT.run(sampleBikeIds[0].id, "repair_request", "Пользователь сообщил: спущено колесо", "open", now - 5400000);
  if (sampleBikeIds[1]) insertT.run(sampleBikeIds[1].id, "repair_request", "Пользователь сообщил: не фиксируется замок", "in_progress", now - 86400000);
  if (sampleBikeIds[2]) insertT.run(sampleBikeIds[2].id, "out_of_zone", "Завершение поездки вне зоны обслуживания", "resolved", now - 172800000);

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
  // OTP verification
  startOtp(input: { name: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyOtp(input: { phone: string; code: string; consentIp?: string }): { user: User } | { error: string };
  // bikes
  listBikes(): Bike[];
  getBike(id: string): Bike | undefined;
  updateBike(id: string, patch: Partial<Bike>): Bike | undefined;
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
  // payments / wallet
  getWallet(userId: string): Wallet;
  topUp(userId: string, amount: number): { wallet: Wallet; payment: Payment };
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number): { wallet: Wallet; payment: Payment };
  listPayments(userId: string): Payment[];
  // tickets
  listTickets(): Ticket[];
  createTicket(input: { bikeId: string; kind: string; message: string }): Ticket;
  updateTicketStatus(id: number, status: string): Ticket | undefined;
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

  listBikes() { return db.select().from(bikes).all() as Bike[]; }
  getBike(id: string) { return db.select().from(bikes).where(eq(bikes.id, id)).get() as Bike | undefined; }
  updateBike(id: string, patch: Partial<Bike>) {
    db.update(bikes).set(patch as any).where(eq(bikes.id, id)).run();
    return this.getBike(id);
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

  createTicket({ bikeId, kind, message }: { bikeId: string; kind: string; message: string }) {
    return db.insert(tickets).values({
      bikeId, kind, message, status: "open", createdAt: Date.now(),
    }).returning().get() as Ticket;
  }

  updateTicketStatus(id: number, status: string) {
    db.update(tickets).set({ status }).where(eq(tickets.id, id)).run();
    return db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
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
