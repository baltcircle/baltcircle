// Shared state and helpers used across multiple storage domains.
//
// Every domain mixin (server/storage/*.ts) is applied on top of this class,
// so members here are `protected`/public rather than `private` — a `private`
// field or method is not visible to a subclass defined in a different file,
// which is exactly what every mixin is.
import type { Bike, User, UserRole } from "@shared/schema";
import { findNearestParkingWithinRadius } from "@shared/geo";
import { bikeEvents, BIKE_EVENT_CHANNEL } from "./events";
import type { IBikeStorage, IParkingStorage } from "./interfaces";

// ---------- Admin phone / role resolution ----------
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

// Normalize a user-entered phone to a storable canonical form: keep digits and
// a single optional leading "+". A Russian "8XXXXXXXXXX" national number is
// converted to "+7XXXXXXXXXX" so duplicates and display stay consistent.
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

export class BaseStorage {
  // ---------- Bikes read cache ----------
  // The public bike list drives the map and is polled/streamed by every
  // viewer, but the underlying rows change rarely (only on ride start/point/
  // end and admin edits). A tiny in-memory TTL cache absorbs the read storm:
  // one DB round-trip refreshes many concurrent readers. Any bike mutation
  // calls invalidateBikesCache() so a stale list is never served past a real
  // change. Only the full row set is cached; per-opts filtering stays cheap.
  //
  // Instance field rather than a `private static` constant (as in the
  // original monolith): a mixin defined in bike.ts cannot reach a `private
  // static` member declared on BaseStorage by name, since that requires
  // referencing the literal `BaseStorage` class from another file. A
  // protected instance field needs no such cross-file static reference.
  //
  // Public rather than protected: bike.ts's listBikes references these
  // through an explicit `this: {...}` structural parameter type (same
  // structural-typing rule as optStr/isUniqueViolation below — a protected
  // member can never satisfy a plain object type from outside the
  // declaring class's hierarchy, even though the real caller is in that
  // hierarchy at runtime).
  readonly bikesCacheTtlMs = 3000;
  _bikesCache: Bike[] | null = null;
  _bikesCacheAt = 0;

  // Drop the cached bike rows so the next listBikes() re-reads from the DB.
  // Call after ANY write that can change a bike's row (status/position/CRUD).
  // По умолчанию также шлём fleet-событие (админка/карта обновятся).
  // silent:true — для position-only обновлений во время поездки (каждая
  // GPS-точка), чтобы не спамить стрим флота — статус там не меняется.
  invalidateBikesCache(opts?: { silent?: boolean }): void {
    this._bikesCache = null;
    this._bikesCacheAt = 0;
    if (!opts?.silent) bikeEvents.emit(BIKE_EVENT_CHANNEL);
  }

  // Normalize an optional string field: trim, and treat "" as null so blank
  // form inputs clear the column rather than storing an empty string.
  //
  // Public rather than protected: several domain mixins (otp.ts,
  // payment-method.ts, ticket.ts) call this cross-mixin through an explicit
  // `this: { isUniqueViolation(...): boolean }`-style structural parameter
  // type. That parameter type is a plain object type, which can only be
  // satisfied by a public member — TypeScript never lets a protected member
  // structurally match a public requirement from outside the declaring
  // class's hierarchy, even though every caller here IS in that hierarchy at
  // runtime. `storage.<method>()` call sites in server/http/* trigger this
  // check, so it fails at the composition root if these stay protected.
  optStr(v: string | undefined): string | null {
    if (v === undefined) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  }

  isUniqueViolation(err: unknown): boolean {
    const code = (e: unknown) => (e as { code?: string } | null | undefined)?.code;
    return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
  }

  /** Replaces a bike's parking reference from its latest stored lock position. */
  async recalculateBikeParking(
    this: IParkingStorage & IBikeStorage,
    bike: Pick<Bike, "id" | "lat" | "lng">,
  ): Promise<void> {
    const match = findNearestParkingWithinRadius(bike.lat, bike.lng, await this.listParkings());
    await this.updateBike(bike.id, { parkingId: match?.id ?? null });
  }
}
