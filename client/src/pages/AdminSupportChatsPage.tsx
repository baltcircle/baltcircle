import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AdminSupportConversationRow,
  SupportConversation,
  SupportMessage,
} from "@shared/schema";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useSupportUnread } from "@/hooks/use-support-unread";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  LifeBuoy, Send, Paperclip, X as XIcon, User as UserIcon, Phone, Loader2, MessageSquare,
} from "lucide-react";
import { fmtRelative } from "@/lib/format";

const INBOX_KEY = ["/api/admin/support/chats"];
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type ChatState = { conversation: SupportConversation; messages: SupportMessage[] };

function chatKey(id: number) { return ["/api/admin/support/chats", id] as const; }

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return "Сегодня";
  if (isYesterday) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
}
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("Не удалось прочитать файл"));
    r.readAsDataURL(file);
  });
}

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
        {/* Список чатов */}
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
            {inboxQ.isLoading ? (
              <div className="text-xs text-muted-foreground text-center py-6">Загружаем…</div>
            ) : filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-6">
                {rows.length === 0 ? "Пока нет обращений." : "Ничего не найдено."}
              </div>
            ) : (
              filtered.map((r) => {
                const active = r.id === selectedId;
                const unread = r.operatorUnreadCount ?? 0;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full text-left p-2.5 rounded-md transition-colors ${
                      active ? "bg-primary/10 border border-primary/40" : "hover:bg-muted/50 border border-transparent"
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

function AdminChatPanel({
  conversationId,
  row,
}: {
  conversationId: number;
  row: AdminSupportConversationRow | null;
}) {
  const toast = useToast();
  const chatQ = useQuery<ChatState>({ queryKey: chatKey(conversationId) });
  const messages = chatQ.data?.messages ?? [];

  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<{ url: string; mime: string; localName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // SSE канал чата
  useEffect(() => {
    const es = new EventSource(
      `${API_BASE}/api/admin/support/chats/${conversationId}/stream`,
      { withCredentials: true },
    );
    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as SupportMessage;
        queryClient.setQueryData<ChatState>(chatKey(conversationId), (prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === msg.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg] };
        });
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [conversationId]);

  // Пометка прочитанным при входе в чат / появлении новых от пользователя
  useEffect(() => {
    if (!messages.length) return;
    apiRequest("POST", `/api/admin/support/chats/${conversationId}/read`, {})
      .then(() => {
        queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      })
      .catch(() => {});
  }, [conversationId, messages.length]);

  const sendMut = useMutation<SupportMessage, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/support/chats/${conversationId}`, {
        body: text.trim(),
        attachmentUrl: attachment?.url,
        attachmentMime: attachment?.mime,
      });
      return res.json();
    },
    onSuccess: (msg) => {
      queryClient.setQueryData<ChatState>(chatKey(conversationId), (prev) => {
        if (!prev) return prev;
        if (prev.messages.some((m) => m.id === msg.id)) return prev;
        return { ...prev, messages: [...prev.messages, msg] };
      });
      queryClient.invalidateQueries({ queryKey: INBOX_KEY });
      setText("");
      setAttachment(null);
    },
    onError: (e) => {
      toast.toast({
        title: "Не отправлено",
        description: e?.message?.replace(/^\d+:\s*/, "") ?? String(e),
        variant: "destructive",
      });
    },
  });

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.toast({ title: "Можно только изображения", variant: "destructive" });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.toast({ title: "Файл слишком большой", description: "Максимум 8 МБ", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await fileToBase64(file);
      const res = await apiRequest("POST", "/api/admin/support/upload", {
        filename: file.name,
        mime: file.type,
        dataBase64: dataUrl,
      });
      const saved = (await res.json()) as { url: string; mime: string };
      setAttachment({ url: saved.url, mime: saved.mime, localName: file.name });
    } catch (err: any) {
      toast.toast({
        title: "Не удалось загрузить",
        description: err?.message?.replace(/^\d+:\s*/, "") ?? String(err),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !attachment) return;
    sendMut.mutate();
  }

  const grouped = useMemo(() => {
    const groups: { day: string; items: SupportMessage[] }[] = [];
    let currentKey = "";
    for (const m of messages) {
      const key = new Date(m.createdAt).toDateString();
      if (key !== currentKey) {
        groups.push({ day: fmtDay(m.createdAt), items: [] });
        currentKey = key;
      }
      groups[groups.length - 1].items.push(m);
    }
    return groups;
  }, [messages]);

  return (
    <div className="flex flex-col h-full min-h-[60vh]">
      {/* Шапка чата */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <UserIcon className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">
            {row?.userName || `Пользователь ${row?.userId ?? ""}`}
          </div>
          {row?.userPhone && (
            <a
              href={`tel:${row.userPhone}`}
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
            >
              <Phone className="w-3 h-3" />{row.userPhone}
            </a>
          )}
        </div>
      </div>

      {/* Сообщения */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="admin-support-chat-messages">
        {chatQ.isLoading ? (
          <div className="text-xs text-muted-foreground text-center py-8">Загрузка…</div>
        ) : messages.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">Сообщений пока нет.</div>
        ) : (
          grouped.map((g, gi) => (
            <div key={gi} className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground text-center py-1">
                {g.day}
              </div>
              {g.items.map((m) => (
                <AdminMessageBubble key={m.id} message={m} />
              ))}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Ввод */}
      <form onSubmit={submit} className="border-t border-border px-3 pt-2 pb-3">
        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 p-2">
            <div className="w-10 h-10 rounded overflow-hidden bg-muted flex items-center justify-center shrink-0">
              <img src={attachment.url} alt="" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs truncate">{attachment.localName}</div>
              <div className="text-[10px] text-muted-foreground">Готово к отправке</div>
            </div>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              className="p-1 rounded hover:bg-muted"
              aria-label="Удалить"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 h-9 w-9"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || sendMut.isPending}
            aria-label="Прикрепить"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
          </Button>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ответ пользователю…"
            rows={1}
            className="flex-1 min-h-[36px] max-h-40 resize-none py-2"
            data-testid="input-admin-support-text"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit(e as any);
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            className="shrink-0 h-9 w-9"
            disabled={sendMut.isPending || uploading || (!text.trim() && !attachment)}
            data-testid="button-admin-support-send"
            aria-label="Отправить"
          >
            {sendMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          Ctrl/⌘ + Enter — отправить
        </div>
      </form>
    </div>
  );
}

function AdminMessageBubble({ message }: { message: SupportMessage }) {
  const isOperator = message.senderRole === "operator";
  const isSystem = message.senderRole === "system";

  if (isSystem) {
    return (
      <div className="text-center text-[10px] text-muted-foreground py-1">{message.body}</div>
    );
  }

  return (
    <div className={`flex ${isOperator ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 ${
          isOperator
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted rounded-bl-md"
        }`}
      >
        {!isOperator && (
          <div className="text-[10px] font-medium opacity-70 mb-0.5">Пользователь</div>
        )}
        {message.attachmentUrl && (
          <a
            href={message.attachmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mb-1"
          >
            <img
              src={message.attachmentUrl}
              alt="Вложение"
              className="max-w-full max-h-72 rounded-lg object-cover"
            />
          </a>
        )}
        {message.body && (
          <div className="text-sm whitespace-pre-wrap break-words leading-snug">{message.body}</div>
        )}
        <div className={`text-[10px] mt-0.5 ${isOperator ? "opacity-70" : "text-muted-foreground"} text-right`}>
          {fmtTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}
