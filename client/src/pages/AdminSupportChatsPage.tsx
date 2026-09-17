import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AdminSupportConversationRow } from "@shared/schema";
import { useSupportUnread } from "@/hooks/use-support-unread";
import { Card } from "@/components/ui/card";
import { MessageSquare } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
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

  // Автовыбор первого при загрузке
  useEffect(() => {
    if (selectedId == null && rows.length > 0) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const pinMut = useMutation<unknown, Error, { id: number; pinned: boolean }>({
    mutationFn: async ({ id, pinned }) =>
      (await apiRequest("POST", `/api/admin/support/chats/${id}/pin`, { pinned })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  });

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-support-chats">
      <h1 className="font-display text-2xl lg:text-3xl font-light mb-6 text-center">Обращения</h1>

      {/* h-[70vh] (важно — фиксированная, не min-h) на lg: без неё grid растягивался по
          содержимому чата, и вся страница тянулась вместо внутреннего скролла в
          ChatList/AdminChatPanel. На мобильной вёрстке (одна колонка) остаётся min-h. */}
      <div className="grid gap-4 lg:grid-cols-[320px_1fr] min-h-[70vh] lg:h-[70vh]">
        <ChatList
          rows={rows}
          filtered={filtered}
          isLoading={inboxQ.isLoading}
          query={query}
          setQuery={setQuery}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          onTogglePin={(id, pinned) => pinMut.mutate({ id, pinned })}
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
