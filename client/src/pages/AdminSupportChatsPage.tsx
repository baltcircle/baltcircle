import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminSupportConversationRow } from "@shared/schema";
import { useSupportUnread } from "@/hooks/use-support-unread";
import { Card } from "@/components/ui/card";
import { LifeBuoy, MessageSquare } from "lucide-react";
import { INBOX_KEY } from "./support-chats/utils";
import { ChatList } from "./support-chats/ChatList";
import { AdminChatPanel } from "./support-chats/AdminChatPanel";

export function AdminSupportChatsPage() {
  const inboxQ = useQuery<AdminSupportConversationRow[]>({
    queryKey: INBOX_KEY,
  });
  const rows = inboxQ.data ?? [];

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  // Звуковое уведомление + inbox SSE + polling в одном месте.
  useSupportUnread();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = `${r.userName ?? ""} ${r.userPhone ?? ""} ${r.lastMessagePreview ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  const totalUnread = rows.reduce((s, r) => s + (r.operatorUnreadCount ?? 0), 0);

  // Автовыбор первого при загрузке
  useEffect(() => {
    if (selectedId == null && rows.length > 0) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-support-chats">
      <header className="mb-4 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Поддержка</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1 flex items-center gap-2">
            <LifeBuoy className="w-6 h-6 text-primary" />
            Обращения
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {rows.length} чатов, {totalUnread} новых сообщений.
          </p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr] min-h-[70vh]">
        <ChatList
          rows={rows}
          filtered={filtered}
          isLoading={inboxQ.isLoading}
          query={query}
          setQuery={setQuery}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
        />

        {/* Панель чата */}
        <Card className="flex flex-col overflow-hidden" data-testid="admin-support-chat-panel">
          {selectedId == null ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <div className="text-center">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
                Выберите чат слева
              </div>
            </div>
          ) : (
            <AdminChatPanel
              key={selectedId}
              conversationId={selectedId}
              row={rows.find((r) => r.id === selectedId) ?? null}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
