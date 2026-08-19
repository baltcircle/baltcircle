import { tickets, ticketComments, TICKET_CLOSED_STATUSES } from "@shared/schema";
import type { Ticket, TicketComment, TicketWithComments, CreateTicketInput, UpdateTicketInput } from "@shared/schema";
import { eq, desc, count } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { ITicketStorage, IBikeStorage } from "./interfaces";
import type { Bike } from "@shared/schema";

export function TicketMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements ITicketStorage {
    async listTickets(opts?: { limit?: number; offset?: number }) {
      let q = db.select().from(tickets).orderBy(desc(tickets.createdAt)).$dynamic();
      if (opts?.limit !== undefined) q = q.limit(opts.limit).offset(opts.offset ?? 0);
      return (await q) as Ticket[];
    }

    async countTickets() {
      return (await db.select({ c: count() }).from(tickets))[0].c;
    }

    async getTicket(id: number): Promise<TicketWithComments | undefined> {
      const t = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] as Ticket | undefined;
      if (!t) return undefined;
      const comments = (await db.select().from(ticketComments)
        .where(eq(ticketComments.ticketId, id))
        .orderBy(ticketComments.createdAt)) as TicketComment[];
      return { ...t, comments };
    }

    // Public rather than private: createTicket/updateTicket reference this
    // through an explicit `this: { addEvent(...): Promise<void>; ... }`
    // structural type so their own `this:` annotation stays satisfiable when
    // called externally as storage.createTicket(...) — see base.ts's
    // optStr/isUniqueViolation comment for why a private/protected member
    // can't satisfy that kind of check from outside the class hierarchy.
    async addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event") {
      await db.insert(ticketComments).values({
        ticketId, author, body, kind, createdAt: Date.now(),
      });
    }

    async createTicket(
      this: Pick<IBikeStorage, "getBike" | "updateBike"> & {
        addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event"): Promise<void>;
        getTicket(id: number): Promise<TicketWithComments | undefined>;
      },
      input: CreateTicketInput,
    ): Promise<TicketWithComments> {
      const now = Date.now();
      const title = (input.title ?? "").trim();
      const assignee = (input.assignee ?? "").trim();
      const row = (await db.insert(tickets).values({
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
      }).returning())[0] as Ticket;
      await this.addEvent(row.id, "Система", "Заявка создана", "event");

      // High/critical tickets pull a rentable bike out of rotation into
      // maintenance so it can't be rented while the issue is open. We never touch
      // a bike that's mid-ride (rented) or already out of service.
      if ((input.priority === "high" || input.priority === "critical")) {
        const bike = await this.getBike(input.bikeId);
        if (bike && (bike.status === "available" || bike.status === "reserved")) {
          await this.updateBike(bike.id, { status: "maintenance" });
          await this.addEvent(row.id, "Система", `Велосипед ${bike.id} переведён в обслуживание`, "event");
        }
      }
      return (await this.getTicket(row.id))!;
    }

    async updateTicket(
      this: Pick<IBikeStorage, "getBike" | "updateBike"> & {
        addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event"): Promise<void>;
        getTicket(id: number): Promise<TicketWithComments | undefined>;
        recalculateBikeParking(bike: Pick<Bike, "id" | "lat" | "lng">): Promise<void>;
      },
      id: number,
      patch: UpdateTicketInput,
      actor: string,
    ): Promise<TicketWithComments | undefined> {
      const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] as Ticket | undefined;
      if (!existing) return undefined;
      const now = Date.now();
      const set: Partial<Ticket> = { updatedAt: now };

      if (patch.priority !== undefined && patch.priority !== existing.priority) {
        set.priority = patch.priority;
        await this.addEvent(id, actor, `Приоритет: ${existing.priority} → ${patch.priority}`, "event");
      }
      if (patch.assignee !== undefined) {
        const next = patch.assignee.trim() || null;
        if (next !== (existing.assignee ?? null)) {
          set.assignee = next;
          await this.addEvent(id, actor, next ? `Назначено: ${next}` : "Исполнитель снят", "event");
        }
      }
      if (patch.status !== undefined && patch.status !== existing.status) {
        set.status = patch.status;
        const becameClosed = TICKET_CLOSED_STATUSES.includes(patch.status);
        set.closedAt = becameClosed ? now : null;
        await this.addEvent(id, actor, `Статус: ${existing.status} → ${patch.status}`, "event");
      }

      await db.update(tickets).set(set as any).where(eq(tickets.id, id));

      // Optional action when closing: return the bike to the rental pool if it's
      // currently in maintenance because of this issue.
      if (patch.returnBikeToAvailable) {
        const bike = await this.getBike(existing.bikeId);
        if (bike && bike.status === "maintenance") {
          await this.updateBike(bike.id, { status: "available" });
          await this.recalculateBikeParking(bike);
          await this.addEvent(id, actor, `Велосипед ${bike.id} возвращён в доступные`, "event");
        }
      }
      return this.getTicket(id);
    }

    async addTicketComment(id: number, author: string, body: string): Promise<TicketWithComments | undefined> {
      const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] as Ticket | undefined;
      if (!existing) return undefined;
      await this.addEvent(id, author, body, "comment");
      await db.update(tickets).set({ updatedAt: Date.now() }).where(eq(tickets.id, id));
      return this.getTicket(id);
    }
  };
}
