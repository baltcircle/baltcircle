import { and, asc, avg, count, desc, eq, getTableColumns, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { users, rides, rideFeedback, type AdminRide, type AdminUser, type AdminFeedbackRow } from "@shared/schema";
import { formatFeedbackReason } from "@shared/feedback";
import { parseAdminPage, type AdminPageResult } from "@shared/admin-data";
import { db } from "../db/bootstrap";
import { adminPhoneSet, resolveRole } from "./base";

type Input = Record<string, unknown>;
export async function staffUsers() {
  const phones = Array.from(adminPhoneSet());
  const rows = await db.select().from(users).where(and(
    isNull(users.deletedAt), isNull(users.blockedAt),
    or(inArray(users.role, ["mechanic", "operator", "admin"]), phones.length ? inArray(users.phone, phones) : undefined),
  )).orderBy(asc(users.name), asc(users.id));
  return rows.map((u) => ({ id: u.id, name: u.name, role: resolveRole(u) }));
}
const DEMO_IDS = ["demo", "user-2", "user-3", "user-4", "user-5"];
// User input is always parameterized. Escape LIKE metacharacters so search is
// literal substring matching, as it was with the old client-side includes().
const pattern = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const visibleRides = and(notInArray(rides.userId, DEMO_IDS), inArray(rides.status, ["active", "completed"]));
const rideSelection = { ...getTableColumns(rides), userName: users.name, userPhone: users.phone, rating: rideFeedback.rating };

export async function ridesPage(input: Input): Promise<AdminPageResult<AdminRide>> {
  const { limit, offset, search } = parseAdminPage(input);
  const status = input.status === "completed" ? "completed" : "active";
  const match = search ? or(ilike(users.name, pattern(search)), ilike(users.phone, pattern(search)),
    ilike(rides.bikeId, pattern(search)), ilike(rides.userId, pattern(search))) : undefined;
  const where = and(visibleRides, match);
  const [counts, items] = await Promise.all([
    db.select({ status: rides.status, total: count() }).from(rides).leftJoin(users, eq(users.id, rides.userId))
      .where(where).groupBy(rides.status),
    db.select(rideSelection).from(rides).leftJoin(users, eq(users.id, rides.userId))
      .leftJoin(rideFeedback, eq(rideFeedback.rideId, rides.id))
      .where(and(where, eq(rides.status, status))).orderBy(desc(rides.startedAt), desc(rides.id)).limit(limit).offset(offset),
  ]);
  const totals = { active: 0, completed: 0 };
  for (const row of counts) {
    if (row.status === "active" || row.status === "completed") totals[row.status] = Number(row.total);
  }
  return { items: items as AdminRide[], total: totals[status], counts: totals };
}

// Independent of historical pagination: even a ride older than 200/20,000
// completed rides remains on the live map. No track hydration or historical rows.
export async function activeAdminRides(): Promise<AdminRide[]> {
  return db.select(rideSelection).from(rides).leftJoin(users, eq(users.id, rides.userId))
    .leftJoin(rideFeedback, eq(rideFeedback.rideId, rides.id))
    .where(and(visibleRides, eq(rides.status, "active"))).orderBy(asc(rides.startedAt), asc(rides.id)) as Promise<AdminRide[]>;
}

export async function rideStats(from: number, to: number): Promise<{ ridesToday: number }> {
  const result = await db.execute(sql`SELECT count(*)::int AS "ridesToday" FROM rides
    WHERE started_at >= ${from} AND started_at <= ${to} AND is_test = false`);
  return result.rows[0] as { ridesToday: number };
}

export async function usersPage(input: Input): Promise<AdminPageResult<AdminUser>> {
  const { limit, offset, search } = parseAdminPage(input);
  const where = and(isNull(users.deletedAt), search ? or(
    ilike(users.name, pattern(search)), ilike(users.phone, pattern(search)), ilike(users.email, pattern(search)),
  ) : undefined);
  const [rows, totals] = await Promise.all([
    db.select().from(users).where(where).orderBy(desc(users.createdAt), desc(users.id)).limit(limit).offset(offset),
    db.select({ total: count(), blocked: sql<number>`count(*) filter (where ${users.blockedAt} is not null)::int` })
      .from(users).where(where),
  ]);
  const ids = rows.map((u) => u.id);
  const [rideCounts, ratings] = ids.length ? await Promise.all([
    db.select({ id: rides.userId, total: count() }).from(rides)
      .where(and(inArray(rides.userId, ids), eq(rides.status, "completed"))).groupBy(rides.userId),
    db.select({ id: rideFeedback.userId, rating: avg(rideFeedback.rating) }).from(rideFeedback)
      .where(inArray(rideFeedback.userId, ids)).groupBy(rideFeedback.userId),
  ]) : [[], []];
  const byCount = new Map(rideCounts.map((r) => [r.id, r.total]));
  const byRating = new Map(ratings.map((r) => [r.id, r.rating === null ? null : Math.round(Number(r.rating) * 100) / 100]));
  return {
    items: rows.map((u) => ({ ...u, role: resolveRole(u), rideCount: byCount.get(u.id) ?? 0, avgRating: byRating.get(u.id) ?? null })),
    total: Number(totals[0].total),
    counts: { blocked: Number(totals[0].blocked) },
  };
}

// Sorting/offset must apply to the merged set, not independently to each source.
// Explicit aliases preserve the existing camelCase HTTP contract.
const feedbackUnion = sql`
  SELECT f.id, 'ride'::text AS kind, f.ride_id AS "rideId", NULL::int AS "conversationId",
    f.user_id AS "userId", f.rating, f.reasons, f.comment, f.created_at::float8 AS "createdAt",
    r.bike_id AS "bikeId", u.name AS "userName", u.phone AS "userPhone"
  FROM ride_feedback f LEFT JOIN rides r ON r.id = f.ride_id LEFT JOIN users u ON u.id = f.user_id
  UNION ALL
  SELECT f.id, 'support'::text, NULL::int, f.conversation_id,
    f.user_id, f.rating, '{}'::text[], NULL::text, f.created_at::float8,
    NULL::text, u.name, u.phone
  FROM support_feedback f LEFT JOIN users u ON u.id = f.user_id`;

export async function feedbackPage(input: Input): Promise<AdminPageResult<AdminFeedbackRow>> {
  const { limit, offset, search } = parseAdminPage(input);
  // Fetch only distinct reason/rating pairs, never all feedback rows, so the
  // column filter includes historical/legacy labels beyond the current page.
  const categoryRows = await db.execute(sql`
    SELECT DISTINCT rating, unnest(reasons) AS reason FROM ride_feedback
    UNION SELECT 0, 'Поддержка' WHERE EXISTS (SELECT 1 FROM support_feedback)`);
  const pairs = categoryRows.rows as { rating: number; reason: string }[];
  const label = (p: { rating: number; reason: string }) => p.rating === 0 ? "Поддержка" : formatFeedbackReason(p.rating, p.reason);
  const categories = Array.from(new Set(pairs.map(label))).sort((a, b) => a.localeCompare(b, "ru"));
  const conditions: SQL[] = [];
  if (search) {
    const p = pattern(search);
    conditions.push(sql`("userName" ILIKE ${p} OR "userPhone" ILIKE ${p} OR "bikeId" ILIKE ${p} OR comment ILIKE ${p})`);
  }
  if (typeof input.rating === "string" && /^[1-5]$/.test(input.rating)) conditions.push(sql`rating = ${Number(input.rating)}`);
  if (typeof input.category === "string" && input.category !== "all") {
    const matches = pairs.filter((p) => label(p) === input.category).map((p) =>
      p.rating === 0 ? sql`kind = 'support'` : sql`(kind = 'ride' AND rating = ${p.rating} AND ${p.reason} = ANY(reasons))`);
    conditions.push(matches.length ? sql`(${sql.join(matches, sql` OR `)})` : sql`false`);
  }
  const where = conditions.length ? sql.join(conditions, sql` AND `) : sql`true`;
  const order = input.direction === "asc" ? sql`ASC` : sql`DESC`;
  const result = await db.execute(sql`
    WITH merged AS (${feedbackUnion}), filtered AS (SELECT * FROM merged WHERE ${where}),
    page AS (SELECT * FROM filtered ORDER BY "createdAt" ${order}, kind ${order}, id ${order} LIMIT ${limit} OFFSET ${offset})
    SELECT (SELECT count(*)::int FROM filtered) AS total,
      COALESCE((SELECT json_agg(page ORDER BY "createdAt" ${order}, kind ${order}, id ${order}) FROM page), '[]'::json) AS items`);
  const row = result.rows[0] as { total: number; items?: AdminFeedbackRow[] };
  return { items: row.items ?? [], total: Number(row.total), categories };
}
