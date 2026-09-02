import { pool } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IAnalyticsStorage, IParkingStorage, IBikeStorage } from "./interfaces";

export function AnalyticsMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IAnalyticsStorage {
    async analytics(this: Pick<IParkingStorage, "listParkings">) {
      const total = Number((await pool.query("SELECT COUNT(*) AS c FROM rides")).rows[0].c);
      const completed = Number((await pool.query("SELECT COUNT(*) AS c FROM rides WHERE status='completed'")).rows[0].c);
      const revenue = Number((await pool.query("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed'")).rows[0].s);
      const avgDuration = Number((await pool.query("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed'")).rows[0].a);
      const avgDistance = Number((await pool.query("SELECT COALESCE(AVG(distance_m),0) AS a FROM rides WHERE status='completed'")).rows[0].a);

      const byDay = (await pool.query(`
        SELECT to_char(to_timestamp(started_at/1000), 'YYYY-MM-DD') AS day,
               COUNT(*) AS rides_count,
               COALESCE(SUM(cost),0) AS revenue
        FROM rides
        GROUP BY day
        ORDER BY day DESC
        LIMIT 14
      `)).rows.reverse();

      // Popular parkings — proximity of ride start. Audit HIGH #18: this used to
      // pull EVERY ride's start coordinates into Node and loop parkings×rides
      // (O(P×R), and the ride history only grows). The aggregation itself moves
      // into one SQL query — Postgres still does a nested-loop-shaped join
      // internally, but the full rides table is never pulled across the wire
      // into Node memory, and there's no per-row JS overhead.
      const allParkings = await this.listParkings();
      const rideStartCounts = new Map<string, number>(
        ((await pool.query(`
          SELECT p.id, COUNT(r.id)::int AS c
          FROM parkings p
          LEFT JOIN rides r
            ON sqrt(power(r.start_lng - p.lng, 2) + power(r.start_lat - p.lat, 2)) < 30
          GROUP BY p.id
        `)).rows as { id: string; c: number }[]).map((row) => [row.id, row.c]),
      );
      const parkingCounts = allParkings
        .map((p) => ({ ...p, rideStarts: rideStartCounts.get(p.id) ?? 0 }))
        .sort((a, b) => b.rideStarts - a.rideStarts);

      const utilisation = (await pool.query(`
        SELECT bike_id, COUNT(*) AS rides
        FROM rides
        GROUP BY bike_id
        ORDER BY rides DESC
        LIMIT 8
      `)).rows;

      const problemBikes = (await pool.query(`
        SELECT * FROM bikes
        WHERE flagged = TRUE OR battery < 25 OR idle_hours > 60
        ORDER BY idle_hours DESC
        LIMIT 12
      `)).rows;

      const idleAvg = Number((await pool.query("SELECT AVG(idle_hours) AS a FROM bikes")).rows[0].a);

      return { total, completed, revenue, avgDuration, avgDistance, byDay, parkingCounts, utilisation, problemBikes, idleAvg };
    }

    // Period-scoped analytics powering the admin "Аналитика v1" page. Everything
    // is computed against rides that *started* within [from, to]. Revenue is the
    // sum of settled ride cost (the current ride/tariff data — no real acquiring).
    async adminAnalytics(
      this: Pick<IParkingStorage, "listParkings"> & Pick<IBikeStorage, "listBikes">,
      range: { from: number; to: number },
    ) {
      const { from, to } = range;
      const q1 = async (sqlStr: string) =>
        (await pool.query(sqlStr, [from, to])).rows[0] as any;

      // ---- KPI cards (selected period) ----
      const ridesCount = Number((await q1("SELECT COUNT(*) AS c FROM rides WHERE started_at >= $1 AND started_at <= $2")).c);
      const activeRides = Number((await q1("SELECT COUNT(*) AS c FROM rides WHERE status='active' AND started_at >= $1 AND started_at <= $2")).c);
      const completedRides = Number((await q1("SELECT COUNT(*) AS c FROM rides WHERE status='completed' AND started_at >= $1 AND started_at <= $2")).c);
      const revenue = Number((await q1("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed' AND started_at >= $1 AND started_at <= $2")).s);
      const avgDuration = Number((await q1("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed' AND ended_at IS NOT NULL AND started_at >= $1 AND started_at <= $2")).a);
      // Average check = revenue per completed (paid) ride in the period.
      const avgCheck = completedRides > 0 ? revenue / completedRides : 0;
      const newUsers = Number((await q1("SELECT COUNT(*) AS c FROM users WHERE created_at >= $1 AND created_at <= $2")).c);
      const usersWithRides = Number((await q1("SELECT COUNT(DISTINCT user_id) AS c FROM rides WHERE started_at >= $1 AND started_at <= $2")).c);
      const openTickets = Number((await pool.query(
        `SELECT COUNT(*) AS c FROM tickets WHERE status NOT IN ('resolved','closed','cancelled')`,
      )).rows[0].c);

      // ---- Rides per day (within the period) for the trend chart ----
      const byDay = (await pool.query(`
        SELECT to_char(to_timestamp(started_at/1000), 'YYYY-MM-DD') AS day,
               COUNT(*) AS rides_count,
               COALESCE(SUM(CASE WHEN status='completed' THEN cost ELSE 0 END),0) AS revenue
        FROM rides
        WHERE started_at >= $1 AND started_at <= $2
        GROUP BY day
        ORDER BY day ASC
      `, [from, to])).rows as any[];

      // ---- Top bikes (most rides) and zero-ride bikes in the period ----
      const ridesByBike = new Map<string, number>();
      for (const row of (await pool.query(
        "SELECT bike_id, COUNT(*) AS c FROM rides WHERE started_at >= $1 AND started_at <= $2 GROUP BY bike_id",
        [from, to],
      )).rows as any[]) {
        ridesByBike.set(row.bike_id, Number(row.c));
      }
      const liveBikes = await this.listBikes(); // excludes archived
      const topBikes = liveBikes
        .map((b) => ({ id: b.id, model: b.model, status: b.status, rides: ridesByBike.get(b.id) ?? 0 }))
        .sort((a, b) => b.rides - a.rides)
        .slice(0, 10);
      const zeroRideBikes = liveBikes
        .filter((b) => (ridesByBike.get(b.id) ?? 0) === 0)
        .map((b) => ({ id: b.id, model: b.model, status: b.status, idleHours: b.idleHours }))
        .sort((a, b) => b.idleHours - a.idleHours);

      // ---- Users summary ----
      const totalUsers = Number((await pool.query("SELECT COUNT(*) AS c FROM users")).rows[0].c);
      const blockedUsers = Number((await pool.query("SELECT COUNT(*) AS c FROM users WHERE blocked_at IS NOT NULL")).rows[0].c);
      const usersSummary = { total: totalUsers, newInPeriod: newUsers, withRidesInPeriod: usersWithRides, blocked: blockedUsers };

      // ---- Service stats (whole-fleet snapshot; tickets are operational, not period-bound) ----
      const ticketsByPriority = (await pool.query(
        "SELECT priority, COUNT(*) AS c FROM tickets GROUP BY priority",
      )).rows as any[];
      const ticketsByStatus = (await pool.query(
        "SELECT status, COUNT(*) AS c FROM tickets GROUP BY status",
      )).rows as any[];
      const ticketsByKind = (await pool.query(
        "SELECT kind, COUNT(*) AS c FROM tickets GROUP BY kind ORDER BY c DESC",
      )).rows as any[];
      // Repeated-problem bikes: more than one ticket ever logged against them.
      const repeatedProblemBikes = (await pool.query(`
        SELECT bike_id, COUNT(*) AS tickets,
               SUM(CASE WHEN status NOT IN ('resolved','closed','cancelled') THEN 1 ELSE 0 END) AS open
        FROM tickets
        GROUP BY bike_id
        HAVING COUNT(*) > 1
        ORDER BY tickets DESC
        LIMIT 12
      `)).rows as any[];

      // ---- Parking usage (proximity of ride starts in the period) ----
      // Audit HIGH #18: same O(P×R) Node loop as analytics() above, moved into
      // one SQL aggregate. The period filter must live in the JOIN's ON clause,
      // not a WHERE after it — a WHERE on r.started_at would turn this into an
      // inner join and drop parkings with zero rides in the period instead of
      // reporting them as rideStarts: 0.
      const parkingRideCounts = new Map<string, number>(
        ((await pool.query(
          `SELECT p.id, COUNT(r.id)::int AS c
           FROM parkings p
           LEFT JOIN rides r
             ON sqrt(power(r.start_lng - p.lng, 2) + power(r.start_lat - p.lat, 2)) < 30
            AND r.started_at >= $1 AND r.started_at <= $2
           GROUP BY p.id`,
          [from, to],
        )).rows as { id: string; c: number }[]).map((row) => [row.id, row.c]),
      );
      const parkingUsage = (await this.listParkings())
        .map((p) => ({
          id: p.id, name: p.name, capacity: p.capacity, occupied: p.occupied,
          rideStarts: parkingRideCounts.get(p.id) ?? 0,
        }))
        .sort((a, b) => b.rideStarts - a.rideStarts);

      // ---- Feedback counts by exact rating (1..5★) for the Analytics
      // "Отзывы" mini-table. Scoped to feedback submitted within the period,
      // consistent with every other KPI on this page.
      const feedbackRatingRow = (await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END), 0) AS r1,
           COALESCE(SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END), 0) AS r2,
           COALESCE(SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END), 0) AS r3,
           COALESCE(SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END), 0) AS r4,
           COALESCE(SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END), 0) AS r5
         FROM ride_feedback
         WHERE created_at >= $1 AND created_at <= $2`,
        [from, to],
      )).rows[0] as { r1: string; r2: string; r3: string; r4: string; r5: string };
      const feedbackCounts = {
        r1: Number(feedbackRatingRow.r1),
        r2: Number(feedbackRatingRow.r2),
        r3: Number(feedbackRatingRow.r3),
        r4: Number(feedbackRatingRow.r4),
        r5: Number(feedbackRatingRow.r5),
      };

      return {
        range: { from, to },
        kpis: {
          ridesCount,
          activeRides,
          completedRides,
          revenue,
          avgDurationMin: avgDuration,
          avgCheck,
          newUsers,
          usersWithRides,
          openTickets,
        },
        byDay,
        topBikes,
        zeroRideBikes,
        usersSummary,
        service: {
          byPriority: ticketsByPriority,
          byStatus: ticketsByStatus,
          byKind: ticketsByKind,
          repeatedProblemBikes,
        },
        parkingUsage,
        feedbackCounts,
      };
    }
  };
}
