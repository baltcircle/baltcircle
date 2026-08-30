import { alerts } from "@shared/schema";
import type { Alert } from "@shared/schema";
import { desc, sql } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IAlertStorage } from "./interfaces";
import { bikeEvents, BIKE_EVENT_CHANNEL } from "./events";

function rowToAlert(row: Record<string, unknown>): Alert {
  return {
    id: row.id as number,
    bikeId: row.bike_id as string,
    kind: row.kind as string,
    severity: row.severity as string,
    message: row.message as string,
    createdAt: Number(row.created_at),
    acknowledgedAt: row.acknowledged_at == null ? null : Number(row.acknowledged_at),
    acknowledgedBy: (row.acknowledged_by as string | null) ?? null,
  };
}

export function AlertMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IAlertStorage {
    /**
     * Best-effort, called from the OMNI fall-alarm event bridge (see
     * server/storage/events.ts + server/storage.ts). The INSERT ... WHERE
     * NOT EXISTS below is an atomic dedup: a lock still lying on the ground
     * keeps re-reporting alarm code 2 on every heartbeat, and this must not
     * spam a fresh row for each one. Returns null when an unacknowledged
     * fall alert for this bike already exists (no-op, not an error).
     */
    async createFallAlert(bikeId: string, at: number): Promise<Alert | null> {
      const result = await db.execute(sql`
        INSERT INTO alerts (bike_id, kind, severity, message, created_at)
        SELECT ${bikeId}, 'fall', 'critical', 'Велосипед упал — требуется проверка', ${at}
        WHERE NOT EXISTS (
          SELECT 1 FROM alerts
          WHERE bike_id = ${bikeId} AND kind = 'fall' AND acknowledged_at IS NULL
        )
        RETURNING id, bike_id, kind, severity, message, created_at, acknowledged_at, acknowledged_by
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      bikeEvents.emit(BIKE_EVENT_CHANNEL);
      return rowToAlert(row);
    }

    async listAlerts(opts?: { includeAcknowledged?: boolean }): Promise<Alert[]> {
      const rows = opts?.includeAcknowledged
        ? await db.select().from(alerts).orderBy(desc(alerts.createdAt))
        : await db.select().from(alerts)
            .where(sql`${alerts.acknowledgedAt} IS NULL`)
            .orderBy(desc(alerts.createdAt));
      return rows as Alert[];
    }

    async acknowledgeAlert(id: number, by: string): Promise<Alert | undefined> {
      const updated = await db.update(alerts)
        .set({ acknowledgedAt: Date.now(), acknowledgedBy: by })
        .where(sql`${alerts.id} = ${id} AND ${alerts.acknowledgedAt} IS NULL`)
        .returning();
      const row = updated[0] as Alert | undefined;
      if (row) bikeEvents.emit(BIKE_EVENT_CHANNEL);
      return row;
    }
  };
}
