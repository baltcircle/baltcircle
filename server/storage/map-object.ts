import { mapObjects } from "@shared/schema";
import type { MapObject, InsertMapObject } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IMapObjectStorage } from "./interfaces";

// map_objects.points хранится как JSON-строка — парсим перед отдачей
// клиенту, чтобы везде API возвращал [number, number][], а не string.
function hydrateMapObject<T extends { points: unknown }>(row: T): T {
  if (typeof (row as any).points === "string") {
    try { (row as any).points = JSON.parse((row as any).points); }
    catch { (row as any).points = []; }
  }
  return row;
}

export function MapObjectMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IMapObjectStorage {
    async listMapObjects(opts?: { activeOnly?: boolean }) {
      const rows = (await db.select().from(mapObjects).orderBy(desc(mapObjects.createdAt))) as MapObject[];
      const parsed = rows.map(hydrateMapObject);
      return opts?.activeOnly ? parsed.filter((o) => o.active) : parsed;
    }

    async createMapObject(input: InsertMapObject) {
      const row = (await db.insert(mapObjects).values({
        name: input.name,
        type: input.type,
        kind: input.kind,
        color: input.color,
        points: JSON.stringify(input.points),
        active: input.active,
        createdAt: Date.now(),
      }).returning())[0] as MapObject;
      return hydrateMapObject(row);
    }

    async setMapObjectActive(id: number, active: boolean) {
      return this.updateMapObject(id, { active });
    }

    async updateMapObject(id: number, patch: Partial<{
      name: string;
      type: "route" | "operating" | "slow" | "forbidden";
      kind: "route" | "zone";
      color: string;
      points: [number, number][];
      active: boolean;
    }>) {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.type !== undefined) set.type = patch.type;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.color !== undefined) set.color = patch.color;
      if (patch.points !== undefined) set.points = JSON.stringify(patch.points);
      if (patch.active !== undefined) set.active = patch.active;
      if (Object.keys(set).length === 0) {
        const row = (await db.select().from(mapObjects).where(eq(mapObjects.id, id)).limit(1))[0] as MapObject | undefined;
        return row ? hydrateMapObject(row) : undefined;
      }
      await db.update(mapObjects).set(set as any).where(eq(mapObjects.id, id));
      const row = (await db.select().from(mapObjects).where(eq(mapObjects.id, id)).limit(1))[0] as MapObject | undefined;
      return row ? hydrateMapObject(row) : undefined;
    }

    async deleteMapObject(id: number) {
      const res = await db.delete(mapObjects).where(eq(mapObjects.id, id));
      return (res.rowCount ?? 0) > 0;
    }
  };
}
