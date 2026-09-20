import { and, count, desc, eq, getTableColumns, lt, or, sql } from "drizzle-orm";
import { rides, rideFeedback } from "@shared/schema";
import type { RiderHistoryPage, RiderStats } from "@shared/rider-data";
import { db } from "../db/bootstrap";

// Caller identity is provided exclusively by the authenticated HTTP session.
export async function riderHistory(userId: string, before?: { startedAt: number; id: number }): Promise<RiderHistoryPage> {
  const rows = await db.select({ ...getTableColumns(rides), rating: rideFeedback.rating })
    .from(rides).leftJoin(rideFeedback, eq(rideFeedback.rideId, rides.id))
    .where(and(eq(rides.userId, userId), eq(rides.isTest, false), before ? or(
      lt(rides.startedAt, before.startedAt),
      and(eq(rides.startedAt, before.startedAt), lt(rides.id, before.id)),
    ) : undefined))
    .orderBy(desc(rides.startedAt), desc(rides.id)).limit(41);
  const items = rows.slice(0, 40);
  const last = items[items.length - 1];
  return { items, nextBefore: rows.length > 40 ? `${last.startedAt}:${last.id}` : null };
}
export async function riderStats(userId: string): Promise<RiderStats> {
  const [row] = await db.select({ rides: count(), distanceM: sql<number>`coalesce(sum(${rides.distanceM}), 0)::float8` })
    .from(rides).where(and(eq(rides.userId, userId), eq(rides.isTest, false)));
  return { rides: Number(row.rides), distanceM: Number(row.distanceM) };
}
