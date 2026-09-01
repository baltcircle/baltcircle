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
     * Shared by createFallAlert/createMovementAlert below. The INSERT ...
     * WHERE NOT EXISTS is an atomic dedup: a lock stuck in an alarm state
     * keeps re-reporting the same code on every heartbeat, and this must not
     * spam a fresh row for each one. Returns null when an unacknowledged
     * alert of this `kind` already exists for the bike (no-op, not an error).
     */
    private async createAlertRow(bikeId: string, kind: string, severity: string, message: string, at: number): Promise<Alert | null> {
      const result = await db.execute(sql`
        INSERT INTO alerts (bike_id, kind, severity, message, created_at)
        SELECT ${bikeId}, ${kind}, ${severity}, ${message}, ${at}
        WHERE NOT EXISTS (
          SELECT 1 FROM alerts
          WHERE bike_id = ${bikeId} AND kind = ${kind} AND acknowledged_at IS NULL
        )
        RETURNING id, bike_id, kind, severity, message, created_at, acknowledged_at, acknowledged_by
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      bikeEvents.emit(BIKE_EVENT_CHANNEL);
      return rowToAlert(row);
    }

    /** Best-effort, called from the OMNI fall-alarm event bridge (alarm code 2). */
    async createFallAlert(bikeId: string, at: number): Promise<Alert | null> {
      return this.createAlertRow(bikeId, "fall", "critical", "Велосипед упал — требуется проверка", at);
    }

    /** Best-effort, called from the OMNI movement-alarm event bridge (alarm code 1). */
    async createMovementAlert(bikeId: string, at: number): Promise<Alert | null> {
      return this.createAlertRow(
        bikeId, "movement_alarm", "critical",
        "Несанкционированное перемещение велосипеда — требуется проверка", at,
      );
    }

    /**
     * Best-effort, called after a bike auto-transitions "available"/"rented"
     * -> "offline" on low battery (bike.ts/ride.ts). Reuses the existing
     * `low_battery` kind (shared/schema.ts's ALERT_KINDS) — it was reserved
     * for exactly this "auto-service transition" case and had no producer
     * yet. Same dedup as fall/movement: a bike stuck offline on a dead
     * battery keeps re-reporting on every heartbeat and must not spam a
     * fresh row each time.
     */
    async createLowBatteryOfflineAlert(bikeId: string, battery: number, at: number): Promise<Alert | null> {
      return this.createAlertRow(
        bikeId, "low_battery", "high",
        `Велосипед ${bikeId} переведён в статус «оффлайн»: заряд замка ${battery}%`, at,
      );
    }

    /**
     * Best-effort, called from endRide's post-commit overage-settlement helper
     * (server/storage/ride.ts) when the real card/SBP charge for a ride's
     * overage fails (decline, no usable method, network error). Deliberately
     * a PLAIN INSERT with no dedup: createAlertRow's bikeId+kind dedup would
     * wrongly suppress a second, unrelated rider's failed overage charge on
     * the same bike — every failure is its own actionable, ride-specific
     * incident for the operator to follow up on.
     */
    async createOverageChargeFailedAlert(
      bikeId: string, rideId: number, userId: string, amountKopecks: number, reason: string, at: number,
    ): Promise<Alert | null> {
      const rub = (amountKopecks / 100).toFixed(2);
      const result = await db.execute(sql`
        INSERT INTO alerts (bike_id, kind, severity, message, created_at)
        VALUES (
          ${bikeId}, 'overage_charge_failed', 'high',
          ${`Не удалось списать овертайм по поездке #${rideId} (райдер ${userId}): ${rub} ₽. Причина: ${reason}`},
          ${at}
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
