import { useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SupportTicket } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fmtDate } from "@/lib/format";
import { Send, MessageCircle } from "lucide-react";

const TICKETS_KEY = ["/api/support/tickets"];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Как начать аренду?",
    a: "Отсканируйте QR-код на велосипеде или выберите велосипед на карте и нажмите «Арендовать».",
  },
  {
    q: "Как оплачивается поездка?",
    a: "Стоимость поездки списывается с привязанного способа оплаты. Привязать карту или СБП можно в разделе «Способы оплаты».",
  },
  {
    q: "Что делать, если велосипед неисправен?",
    a: "Завершите поездку в разрешённой зоне и опишите проблему через форму ниже — мы передадим заявку оператору.",
  },
];

export function SupportPage() {
  const toast = useToast();
  const { isRegistered } = useCurrentUser();

  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ticketsQ = useQuery<SupportTicket[]>({ queryKey: TICKETS_KEY });
  const tickets = ticketsQ.data ?? [];

  const createMut = useMutation<SupportTicket, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/support/tickets", {
        subject: subject.trim(),
        message: message.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TICKETS_KEY });
      setSubject("");
      setMessage("");
      setError(null);
      toast.toast({ title: "Обращение отправлено", description: "Мы свяжемся с вами в ближайшее время." });
    },
    onError: (e) => setError(e?.message?.replace(/^\d+:\s*/, "") ?? "Не удалось отправить обращение"),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (subject.trim().length < 3) return setError("Укажите тему обращения (минимум 3 символа)");
    if (message.trim().length < 5) return setError("Опишите вопрос подробнее (минимум 5 символов)");
    setError(null);
    createMut.mutate();
  }

  return (
    <OverlayShell title="Помощь">
      <div className="px-4 py-4 max-w-2xl mx-auto space-y-3" data-testid="page-support">
        {/* FAQ */}
        <Card className="p-4" data-testid="card-support-faq">
          <div className="text-sm font-medium mb-2">Частые вопросы</div>
          <div className="space-y-2.5">
            {FAQ.map((item, i) => (
              <div key={i} data-testid={`faq-item-${i}`}>
                <div className="font-light text-sm">{item.q}</div>
                <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{item.a}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Compact contact form */}
        <Card className="p-4" data-testid="card-support-form">
          <div className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <MessageCircle className="w-4 h-4" /> Написать в поддержку
          </div>
          {!isRegistered && (
            <p className="text-xs text-muted-foreground mb-2" data-testid="text-support-guest">
              Войдите, чтобы обращения сохранялись в аккаунте.
            </p>
          )}
          <form onSubmit={submit} className="space-y-2">
            <Input
              id="support-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Тема"
              data-testid="input-support-subject"
              className="h-9"
            />
            <Textarea
              id="support-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Опишите ваш вопрос"
              rows={2}
              data-testid="input-support-message"
              className="resize-none"
            />
            {error && <p className="text-xs text-destructive" data-testid="text-support-error">{error}</p>}
            <Button type="submit" size="sm" className="w-full h-9" disabled={createMut.isPending} data-testid="button-support-submit">
              <Send className="w-3.5 h-3.5 mr-1.5" />
              {createMut.isPending ? "Отправка…" : "Отправить"}
            </Button>
          </form>
        </Card>

        {/* Submitted tickets */}
        {(ticketsQ.isLoading || tickets.length > 0) && (
          <Card className="p-4" data-testid="card-support-tickets">
            <div className="text-sm font-medium mb-2">Ваши обращения</div>
            {ticketsQ.isLoading ? (
              <div className="text-xs text-muted-foreground" data-testid="support-tickets-loading">Загрузка…</div>
            ) : (
              <ul className="space-y-2" data-testid="support-tickets-list">
                {tickets.map((t) => (
                  <li key={t.id} className="rounded-md bg-muted/50 p-2.5" data-testid={`support-ticket-${t.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-light text-sm flex-1 truncate">{t.subject}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{fmtDate(t.createdAt)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2 whitespace-pre-wrap">{t.message}</div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
                      {t.status === "resolved" ? "Решено" : "Открыто"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </OverlayShell>
  );
}
