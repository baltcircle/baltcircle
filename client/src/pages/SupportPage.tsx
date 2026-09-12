import { useEffect, useMemo, useRef, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SupportMessage } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { LifeBuoy } from "lucide-react";
import { BOT_GREETING, SUPPORT_SESSION_CLOSED_NOTE } from "@shared/support-faq";
import { CHAT_KEY, MAX_FILE_BYTES, type ChatState, fmtDay, fileToBase64 } from "./support/utils";
import { MessageBubble } from "./support/MessageBubble";
import { SupportQuickActions } from "./support/SupportQuickActions";
import { ChatInputForm } from "./support/ChatInputForm";
import { SupportRatingCard } from "./support/SupportRatingCard";

// Какие id заметок закрытия уже получили оценку — чтобы после ответа
// карточка не всплывала снова при следующем открытии чата/перезагрузке страницы.
const RATED_NOTE_IDS_KEY = "support_rated_close_note_ids";
function loadRatedNoteIds(): Set<number> {
  try {
    const raw = localStorage.getItem(RATED_NOTE_IDS_KEY);
    return new Set(raw ? (JSON.parse(raw) as number[]) : []);
  } catch {
    return new Set();
  }
}
function markNoteRated(id: number) {
  try {
    const ids = loadRatedNoteIds();
    ids.add(id);
    localStorage.setItem(RATED_NOTE_IDS_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* localStorage недоступен — карточка может перепоказаться, не критично */ }
}

export function SupportPage() {
  const toast = useToast();
  const { isRegistered } = useCurrentUser();

  const chatQ = useQuery<ChatState>({ queryKey: CHAT_KEY, enabled: isRegistered });
  const messages = chatQ.data?.messages ?? [];

  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<{ url: string; previewUrl: string; mime: string; localName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [ratedNoteIds, setRatedNoteIds] = useState<Set<number>>(() => loadRatedNoteIds());
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Актуальная высота fixed-приклеенного к низу поля ввода — резервируется
  // отступом в области сообщений, чтобы последнее сообщение не скрылось за ним.
  const [inputHeight, setInputHeight] = useState(72);

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
      const saved = (await res.json()) as { url: string; previewUrl: string; mime: string };
      setAttachment({ url: saved.url, previewUrl: saved.previewUrl, mime: saved.mime, localName: file.name });
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

  // Тихое закрытие раунда: бот справился, админку не уведомляем.
  const resolveMut = useMutation<SupportMessage, Error, void>({
    mutationFn: async () => (await apiRequest("POST", "/api/support/chat/resolve", {})).json(),
    onSuccess: (msg) => {
      queryClient.setQueryData<ChatState>(CHAT_KEY, (prev) => {
        if (!prev) return prev;
        if (prev.messages.some((m) => m.id === msg.id)) return prev;
        return { ...prev, messages: [...prev.messages, msg] };
      });
    },
  });

  // Явный вызов живого оператора — с уведомлением админки.
  const escalateMut = useMutation<{ message: SupportMessage | null; alreadyHuman: boolean }, Error, void>({
    mutationFn: async () => (await apiRequest("POST", "/api/support/chat/escalate", {})).json(),
    onSuccess: (res) => {
      queryClient.setQueryData<ChatState>(CHAT_KEY, (prev) => {
        if (!prev) return prev;
        const withMode = { ...prev, conversation: { ...prev.conversation, mode: "human" as const } };
        if (!res.message) return withMode;
        if (withMode.messages.some((m) => m.id === res.message!.id)) return withMode;
        return { ...withMode, messages: [...withMode.messages, res.message] };
      });
    },
  });

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

  // Кнопки «Вопрос решён» / «Позвать оператора» показываем только сразу
  // после автоответа бота, пока разговор ещё не передан оператору — как
  // только придёт новое сообщение (пользователя, системное или оператора),
  // последним в списке будет уже не bot-сообщение, и кнопки сами исчезнут.
  const lastMessage = messages[messages.length - 1];
  const showQuickActions =
    !!lastMessage && lastMessage.senderRole === "bot" && chatQ.data?.conversation.mode === "bot";

  // Карточку рейтинга всегда показываем по содержимому последнего сообщения,
  // а не по отдельному эфемерному SSE-событию: если оно пропадёт при разрыве
  // соединения, заметка (обычное сообщение) всё равно доедет через обычный
  // запрос чата, и карточка появится всё равно.
  const closingNote =
    lastMessage && lastMessage.senderRole === "system" && lastMessage.body === SUPPORT_SESSION_CLOSED_NOTE
      ? lastMessage
      : null;
  const showRating = closingNote != null && !ratedNoteIds.has(closingNote.id);

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
        {/* Область сообщений (скролл ведёт внешний OverlayShell).
            flex-col + justify-end прижимает контент к низу, когда сообщений
            мало — иначе flex-1 растягивал бы пустое место МЕЖДУ сообщениями
            и полем ввода вместо того, чтобы оставить его сверху, у заголовка;
            это же убирает лишний скролл всего раздела на короткой переписке. */}
        <div
          ref={scrollerRef}
          className="flex-1 flex flex-col justify-end px-3 pt-3 space-y-3"
          style={{ paddingBottom: inputHeight + 12 }}
          data-testid="support-chat-messages"
        >
          {chatQ.isLoading ? (
            <div className="text-xs text-muted-foreground text-center py-8">Загрузка чата…</div>
          ) : (
            <>
              {/* Приветствие бота — всегда первым, не хранится в БД. FAQ теперь
                  скрыт внутри свободного текста: бот сам разбирает вопрос. */}
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-muted px-3 py-2">
                  <div className="text-[10px] font-medium opacity-70 mb-0.5">Бот поддержки</div>
                  <div className="text-sm whitespace-pre-wrap break-words leading-snug">{BOT_GREETING}</div>
                </div>
              </div>
              {grouped.map((g, gi) => (
                <div key={gi} className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground text-center py-1">
                    {g.day}
                  </div>
                  {g.items.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))}
                </div>
              ))}
              {showQuickActions && (
                <SupportQuickActions
                  onResolve={() => resolveMut.mutate()}
                  onEscalate={() => escalateMut.mutate()}
                  resolving={resolveMut.isPending}
                  escalating={escalateMut.isPending}
                />
              )}
              {showRating && (
                <SupportRatingCard
                  onDone={() => {
                    markNoteRated(closingNote!.id);
                    setRatedNoteIds(loadRatedNoteIds());
                  }}
                />
              )}
            </>
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
          onHeightChange={setInputHeight}
        />
      </div>
    </OverlayShell>
  );
}
