import type { AdminSupportConversationRow } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Phone, Pin } from "lucide-react";
import { fmtRelative } from "@/lib/format";

export function ChatList({
  rows, filtered, isLoading, query, setQuery, selectedId, setSelectedId, onTogglePin,
}: {
  rows: AdminSupportConversationRow[];
  filtered: AdminSupportConversationRow[];
  isLoading: boolean;
  query: string;
  setQuery: (v: string) => void;
  selectedId: number | null;
  setSelectedId: (id: number) => void;
  onTogglePin: (id: number, pinned: boolean) => void;
}) {
  return (
    <Card className="p-2 flex flex-col overflow-hidden" data-testid="admin-support-chat-list">
      <div className="p-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по имени, телефону, тексту"
          className="h-9"
          data-testid="input-admin-support-search"
        />
      </div>
      <div className="flex-1 overflow-y-auto space-y-1">
        {isLoading ? (
          <div className="text-xs text-muted-foreground text-center py-6">Загружаем…</div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-6">
            {rows.length === 0 ? "Пока нет обращений." : "Ничего не найдено."}
          </div>
        ) : (
          filtered.map((r) => {
            const active = r.id === selectedId;
            const unread = r.operatorUnreadCount ?? 0;
            const pinned = r.pinnedAt != null;
            return (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`w-full text-left p-2.5 rounded-md transition-colors ${
                  active
                    ? "bg-primary/10 border border-primary/40"
                    : pinned
                      ? "bg-amber-500/5 hover:bg-amber-500/10 border border-transparent"
                      : "hover:bg-muted/50 border border-transparent"
                }`}
                data-testid={`admin-support-chat-item-${r.id}`}
              >
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium truncate flex-1">
                    {r.userName || `Пользователь ${r.userId}`}
                  </div>
                  {unread > 0 && (
                    <Badge variant="default" className="text-[10px] h-5">{unread}</Badge>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(r.id, !pinned);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      onTogglePin(r.id, !pinned);
                    }}
                    className="p-1 -m-1 rounded hover:bg-muted shrink-0"
                    title={pinned ? "Открепить чат" : "Закрепить чат"}
                    data-testid={`button-pin-chat-${r.id}`}
                  >
                    <Pin className={`w-3.5 h-3.5 ${pinned ? "text-primary fill-current" : "text-muted-foreground"}`} />
                  </span>
                </div>
                {r.userPhone && (
                  <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <Phone className="w-3 h-3" />{r.userPhone}
                  </div>
                )}
                {r.lastMessagePreview && (
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                    {r.lastMessagePreview}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mt-1">
                  {r.lastMessageAt != null ? fmtRelative(r.lastMessageAt) : ""}
                </div>
              </button>
            );
          })
        )}
      </div>
    </Card>
  );
}
