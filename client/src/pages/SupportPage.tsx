import { useEffect, useMemo, useRef, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SupportMessage } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { LifeBuoy } from "lucide-react";
import { CHAT_KEY, MAX_FILE_BYTES, type ChatState, fmtDay, fileToBase64 } from "./support/utils";
import { MessageBubble } from "./support/MessageBubble";
import { FaqEmptyState } from "./support/FaqEmptyState";
import { ChatInputForm } from "./support/ChatInputForm";

export function SupportPage() {
  const toast = useToast();
  const { isRegistered } = useCurrentUser();

  const chatQ = useQuery<ChatState>({ queryKey: CHAT_KEY, enabled: isRegistered });
  const messages = chatQ.data?.messages ?? [];

  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<{ url: string; mime: string; localName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Автоскролл вниз при новом сообщении
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // SSE стрим новых сообщений от оператора
  useEffect(() => {
    if (!isRegistered) return;
    const es = new EventSource(`${API_BASE}/api/support/chat/stream`, { withCredentials: true });
    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as SupportMessage;
        queryClient.setQueryData<ChatState>(CHAT_KEY, (prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === msg.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg] };
        });
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* EventSource сам переподключится */ };
    return () => es.close();
  }, [isRegistered]);

  // Пометка прочитанным при открытии/новых сообщениях от оператора
  useEffect(() => {
    if (!isRegistered) return;
    const hasOperator = messages.some((m) => m.senderRole === "operator");
    if (!hasOperator) return;
    apiRequest("POST", "/api/support/chat/read", {}).catch(() => {});
  }, [isRegistered, messages.length]);

  const sendMut = useMutation<SupportMessage, Error, string | void>({
    mutationFn: async (override) => {
      const res = await apiRequest("POST", "/api/support/chat", {
        body: typeof override === "string" ? override : text.trim(),
        attachmentUrl: typeof override === "string" ? undefined : attachment?.url,
        attachmentMime: typeof override === "string" ? undefined : attachment?.mime,
      });
      return res.json();
    },
    onSuccess: (msg) => {
      queryClient.setQueryData<ChatState>(CHAT_KEY, (prev) => {
        if (!prev) return prev;
        if (prev.messages.some((m) => m.id === msg.id)) return prev;
        return { ...prev, messages: [...prev.messages, msg] };
      });
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
      const res = await apiRequest("POST", "/api/support/chat/upload", {
        filename: file.name,
        mime: file.type,
        dataBase64: dataUrl,
      });
      const saved = (await res.json()) as { url: string; mime: string };
      setAttachment({ url: saved.url, mime: saved.mime, localName: file.name });
    } catch (err: any) {
      toast.toast({
        title: "Не удалось загрузить файл",
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

  // Быстрый вызов оператора — шлём ключевое слово, бот переключит разговор.
  function callOperator() {
    if (sendMut.isPending) return;
    sendMut.mutate("Оператор");
  }

  // Группировка по дате для разделителей
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

  if (!isRegistered) {
    return (
      <OverlayShell title="Помощь">
        <div className="px-4 py-6 max-w-2xl mx-auto space-y-3" data-testid="page-support">
          <Card className="p-10 text-center" data-testid="empty-support-guest">
            <LifeBuoy className="w-10 h-10 mx-auto opacity-40 mb-3" />
            <div className="font-display text-lg font-light mb-1">Поддержка доступна после входа</div>
            <div className="text-sm text-muted-foreground mb-6">
              Войдите в аккаунт, чтобы написать в поддержку.
            </div>
          </Card>
        </div>
      </OverlayShell>
    );
  }

  return (
    <OverlayShell title="Поддержка">
      <div className="relative flex flex-col min-h-full max-w-2xl w-full mx-auto" data-testid="page-support-chat">
        {/* Область сообщений (скролл ведёт внешний OverlayShell) */}
        <div
          ref={scrollerRef}
          className="flex-1 px-3 py-3 space-y-3 pb-24"
          data-testid="support-chat-messages"
        >
          {chatQ.isLoading ? (
            <div className="text-xs text-muted-foreground text-center py-8">Загрузка чата…</div>
          ) : messages.length === 0 ? (
            <FaqEmptyState
              onPickFaq={(q) => sendMut.mutate(q)}
              onCallOperator={callOperator}
              disabled={sendMut.isPending}
            />
          ) : (
            grouped.map((g, gi) => (
              <div key={gi} className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground text-center py-1">
                  {g.day}
                </div>
                {g.items.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Поле ввода — приклеено к низу внешнего скроллера */}
        <ChatInputForm
          onSubmit={submit}
          attachment={attachment}
          onRemoveAttachment={() => setAttachment(null)}
          fileRef={fileRef}
          onPickFile={onPickFile}
          uploading={uploading}
          sending={sendMut.isPending}
          text={text}
          setText={setText}
        />
      </div>
    </OverlayShell>
  );
}
