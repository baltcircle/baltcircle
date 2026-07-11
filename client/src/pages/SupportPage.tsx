import { useEffect, useMemo, useRef, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SupportConversation, SupportMessage } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Send, Paperclip, X as XIcon, ImageIcon, Loader2 } from "lucide-react";

const CHAT_KEY = ["/api/support/chat"];
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type ChatState = { conversation: SupportConversation; messages: SupportMessage[] };

const FAQ_HINT = [
  { q: "Как начать аренду?", a: "Отсканируйте QR-код на велосипеде или выберите его на карте." },
  { q: "Что делать, если велосипед неисправен?", a: "Завершите поездку в разрешённой зоне и напишите нам ниже." },
];

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

  const sendMut = useMutation<SupportMessage, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/support/chat", {
        body: text.trim(),
        attachmentUrl: attachment?.url,
        attachmentMime: attachment?.mime,
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
          <Card className="p-4">
            <div className="text-sm">Войдите в аккаунт, чтобы написать в поддержку.</div>
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
            <Card className="p-4 space-y-3">
              <div className="text-sm font-medium">Здравствуйте. Мы на связи.</div>
              <div className="text-xs text-muted-foreground leading-snug">
                Напишите ваш вопрос или прикрепите фото — оператор ответит в чате.
              </div>
              <div className="space-y-2 pt-1">
                {FAQ_HINT.map((f, i) => (
                  <div key={i}>
                    <div className="text-xs font-medium">{f.q}</div>
                    <div className="text-xs text-muted-foreground">{f.a}</div>
                  </div>
                ))}
              </div>
            </Card>
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
        <form
          onSubmit={submit}
          className="sticky bottom-0 z-10 border-t border-border/50 bg-background/95 backdrop-blur px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
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
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="shrink-0 h-9 w-9"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || sendMut.isPending}
              aria-label="Прикрепить фото"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </Button>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Сообщение…"
              rows={1}
              className="flex-1 min-h-[36px] max-h-32 resize-none py-2"
              data-testid="input-support-text"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
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
              data-testid="button-support-send"
              aria-label="Отправить"
            >
              {sendMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </form>
      </div>
    </OverlayShell>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  const isUser = message.senderRole === "user";
  const isSystem = message.senderRole === "system";

  if (isSystem) {
    return (
      <div className="text-center text-[10px] text-muted-foreground py-1">
        {message.body}
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`} data-testid={`support-msg-${message.id}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 ${
          isUser
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted rounded-bl-md"
        }`}
      >
        {!isUser && (
          <div className="text-[10px] font-medium opacity-70 mb-0.5">Оператор</div>
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
              className="max-w-full max-h-64 rounded-lg object-cover"
            />
          </a>
        )}
        {message.body && (
          <div className="text-sm whitespace-pre-wrap break-words leading-snug">{message.body}</div>
        )}
        <div className={`text-[10px] mt-0.5 ${isUser ? "opacity-70" : "text-muted-foreground"} text-right`}>
          {fmtTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}

// Пустая иконка чтобы не терять импорт (использовать в v2)
void ImageIcon;
