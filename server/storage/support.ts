import { supportTickets, supportConversations, supportMessages, users } from "@shared/schema";
import type {
  SupportTicket, SupportTicketWithUser, SupportTicketStatus, SupportConversation,
  SupportMessage, SupportMessageRole, AdminSupportConversationRow,
} from "@shared/schema";
import { eq, desc, gt, and, asc, sql } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { ISupportStorage } from "./interfaces";

export function SupportMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements ISupportStorage {
    async listSupportTickets(userId: string) {
      return (await db.select().from(supportTickets)
        .where(eq(supportTickets.userId, userId))
        .orderBy(desc(supportTickets.createdAt))) as SupportTicket[];
    }

    async createSupportTicket({ userId, subject, message }: { userId: string; subject: string; message: string }) {
      return (await db.insert(supportTickets).values({
        userId, subject: subject.trim(), message: message.trim(), status: "open", createdAt: Date.now(),
      }).returning())[0] as SupportTicket;
    }

    // Staff inbox: every rider request across the platform, newest first, with
    // a light join on users so the operator sees who submitted the ticket.
    async listAllSupportTickets(): Promise<SupportTicketWithUser[]> {
      const rows = await db
        .select({
          id: supportTickets.id,
          userId: supportTickets.userId,
          subject: supportTickets.subject,
          message: supportTickets.message,
          status: supportTickets.status,
          createdAt: supportTickets.createdAt,
          userName: users.name,
          userPhone: users.phone,
        })
        .from(supportTickets)
        .leftJoin(users, eq(users.id, supportTickets.userId))
        .orderBy(desc(supportTickets.createdAt));
      return rows as SupportTicketWithUser[];
    }

    async updateSupportTicket(id: number, patch: { status?: SupportTicketStatus }): Promise<SupportTicket | undefined> {
      if (!patch.status) return this.getSupportTicket(id);
      const updated = (await db
        .update(supportTickets)
        .set({ status: patch.status })
        .where(eq(supportTickets.id, id))
        .returning())[0] as SupportTicket | undefined;
      return updated;
    }

    private async getSupportTicket(id: number): Promise<SupportTicket | undefined> {
      return (await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1))[0] as SupportTicket | undefined;
    }

    // -------------------- SUPPORT CHAT (единый чат на пользователя) --------------------

    /** Get or lazily create a conversation for the given rider. */
    async ensureSupportConversation(userId: string): Promise<SupportConversation> {
      const existing = (await db.select().from(supportConversations)
        .where(eq(supportConversations.userId, userId)).limit(1))[0] as SupportConversation | undefined;
      if (existing) return existing;
      return (await db.insert(supportConversations).values({
        userId, mode: "bot", createdAt: Date.now(), userUnreadCount: 0, operatorUnreadCount: 0,
      }).returning())[0] as SupportConversation;
    }

    /** Retrieve chat history for a conversation, oldest first (chronological). */
    async listSupportMessages(conversationId: number, opts?: { afterId?: number; limit?: number }): Promise<SupportMessage[]> {
      const conds: any[] = [eq(supportMessages.conversationId, conversationId)];
      if (opts?.afterId && Number.isFinite(opts.afterId)) {
        conds.push(gt(supportMessages.id, opts.afterId));
      }
      const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
      return (await db.select().from(supportMessages)
        .where(conds.length > 1 ? and(...conds) : conds[0])
        .orderBy(asc(supportMessages.id))
        .limit(limit)) as SupportMessage[];
    }

    /** Append a message, bump last_message_at, increment recipient's unread counter. */
    async appendSupportMessage(input: {
      conversationId: number;
      senderRole: SupportMessageRole;
      senderId: string | null;
      body: string;
      attachmentUrl?: string | null;
      attachmentMime?: string | null;
    }): Promise<SupportMessage> {
      const now = Date.now();
      const inserted = (await db.insert(supportMessages).values({
        conversationId: input.conversationId,
        senderRole: input.senderRole,
        senderId: input.senderId,
        body: (input.body ?? "").trim(),
        attachmentUrl: input.attachmentUrl ?? null,
        attachmentMime: input.attachmentMime ?? null,
        createdAt: now,
      }).returning())[0] as SupportMessage;

      // Бампаем счётчик непрочитанного у противоположной стороны + last_message_at
      if (input.senderRole === "user") {
        await db.execute(sql`
          UPDATE support_conversations
          SET last_message_at = ${now}, operator_unread_count = operator_unread_count + 1
          WHERE id = ${input.conversationId}
        `);
      } else {
        // operator / bot / system — всё это исходящие к пользователю сообщения →
        // бампаем его счётчик непрочитанного.
        await db.execute(sql`
          UPDATE support_conversations
          SET last_message_at = ${now}, user_unread_count = user_unread_count + 1
          WHERE id = ${input.conversationId}
        `);
      }
      return inserted;
    }

    /** Переключить режим разговора: 'bot' | 'human'. */
    async setSupportMode(conversationId: number, mode: "bot" | "human"): Promise<void> {
      await db.execute(sql`
        UPDATE support_conversations SET mode = ${mode} WHERE id = ${conversationId}
      `);
    }

    /** Zero-out unread counter for the reader side. */
    async markSupportRead(conversationId: number, reader: "user" | "operator"): Promise<void> {
      // Both branches are plain, fully parameterized updates — no interpolated
      // SQL text, unlike the previous sql.raw(`... ${col} ... ${id}`) version.
      if (reader === "user") {
        await db.update(supportConversations).set({ userUnreadCount: 0 })
          .where(eq(supportConversations.id, conversationId));
      } else {
        await db.update(supportConversations).set({ operatorUnreadCount: 0 })
          .where(eq(supportConversations.id, conversationId));
      }
    }

    /** Admin inbox: all conversations, newest activity first, joined with rider profile. */
    async listAllSupportConversations(): Promise<AdminSupportConversationRow[]> {
      const rows = await db.execute(sql`
        SELECT
          c.id, c.user_id AS "userId", c.mode, c.last_message_at AS "lastMessageAt",
          c.user_unread_count AS "userUnreadCount",
          c.operator_unread_count AS "operatorUnreadCount",
          c.created_at AS "createdAt",
          u.name AS "userName", u.phone AS "userPhone",
          (
            SELECT COALESCE(NULLIF(m.body, ''), CASE WHEN m.attachment_url IS NOT NULL THEN '[вложение]' ELSE NULL END)
            FROM support_messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.id DESC LIMIT 1
          ) AS "lastMessagePreview"
        FROM support_conversations c
        LEFT JOIN users u ON u.id = c.user_id
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      `);
      return (rows as any).rows as AdminSupportConversationRow[];
    }

    async getSupportConversation(id: number): Promise<SupportConversation | undefined> {
      return (await db.select().from(supportConversations)
        .where(eq(supportConversations.id, id)).limit(1))[0] as SupportConversation | undefined;
    }
  };
}
