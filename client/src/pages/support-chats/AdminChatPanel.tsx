import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AdminSupportConversationRow, SupportMessage } from "@shared/schema";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Send, Paperclip, X as XIcon, User as UserIcon, Phone, Loader2,
} from "lucide-react";
import { INBOX_KEY, MAX_FILE_BYTES, type ChatState, chatKey, fmtDay, fileToBase64 } from "./utils";
import { AdminMessageBubble } from "./AdminMessageBubble";

export function AdminChatPanel({
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
  const [attachment, setAttachment] = useState<{ url: string; previewUrl: string; mime: string; localName: string } | null>(null);
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
      const saved = (await res.json()) as { url: string; previewUrl: string; mime: string };
      setAttachment({ url: saved.url, previewUrl: saved.previewUrl, mime: saved.mime, localName: file.name });
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
              <img src={attachment.previewUrl} alt="" className="w-full h-full object-cover" />
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
