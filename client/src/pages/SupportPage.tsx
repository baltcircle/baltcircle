import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SupportTicket } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fmtDate } from "@/lib/format";
import { Link } from "wouter";
import { LifeBuoy, Mail, Phone, Send, MessageCircle, Scale, ChevronRight } from "lucide-react";

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
    q: "Как сменить номер телефона?",
    a: "В «Настройках» нажмите «Изменить телефон» — мы отправим SMS с кодом подтверждения на новый номер.",
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
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-2xl mx-auto" data-testid="page-support">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Поддержка</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1 flex items-center gap-2">
          <LifeBuoy className="w-6 h-6" /> Помощь
        </h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Ответы на частые вопросы и форма обращения в поддержку.
        </p>
      </header>

      {/* Contacts */}
      <Card className="p-5 mb-5" data-testid="card-support-contacts">
        <div className="text-sm font-medium mb-3">Контакты</div>
        <div className="space-y-2 text-sm">
          <a href="mailto:support@takeride.ru" className="flex items-center gap-2 hover:text-foreground text-muted-foreground" data-testid="link-support-email">
            <Mail className="w-4 h-4" /> support@takeride.ru
          </a>
          <a href="tel:+78005550100" className="flex items-center gap-2 hover:text-foreground text-muted-foreground" data-testid="link-support-phone">
            <Phone className="w-4 h-4" /> 8 800 555-01-00
          </a>
        </div>
      </Card>

      {/* FAQ */}
      <Card className="p-5 mb-5" data-testid="card-support-faq">
        <div className="text-sm font-medium mb-3">Частые вопросы</div>
        <div className="space-y-4">
          {FAQ.map((item, i) => (
            <div key={i} data-testid={`faq-item-${i}`}>
              <div className="font-light">{item.q}</div>
              <div className="text-sm text-muted-foreground mt-0.5">{item.a}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Contact form */}
      <Card className="p-5 mb-5" data-testid="card-support-form">
        <div className="text-sm font-medium mb-3 flex items-center gap-1.5">
          <MessageCircle className="w-4 h-4" /> Написать в поддержку
        </div>
        {!isRegistered && (
          <p className="text-xs text-muted-foreground mb-3" data-testid="text-support-guest">
            Войдите, чтобы ваши обращения сохранялись и были привязаны к аккаунту.
          </p>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="support-subject">Тема</Label>
            <Input
              id="support-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Кратко о проблеме"
              data-testid="input-support-subject"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-message">Сообщение</Label>
            <Textarea
              id="support-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Опишите ваш вопрос подробнее"
              rows={4}
              data-testid="input-support-message"
            />
          </div>
          {error && <p className="text-sm text-destructive" data-testid="text-support-error">{error}</p>}
          <Button type="submit" className="w-full" disabled={createMut.isPending} data-testid="button-support-submit">
            <Send className="w-4 h-4 mr-2" />
            {createMut.isPending ? "Отправка…" : "Отправить обращение"}
          </Button>
        </form>
      </Card>

      {/* Legal documents */}
      <Link
        href="/legal"
        data-testid="link-support-legal"
        className="flex items-center gap-3 rounded-xl border bg-card p-4 mb-5 hover:bg-muted/50"
      >
        <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
          <Scale className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-light">Правовые документы</span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Соглашение, правила проката, конфиденциальность, оплата
          </span>
        </span>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </Link>

      {/* Submitted tickets */}
      <Card className="p-5" data-testid="card-support-tickets">
        <div className="text-sm font-medium mb-3">Ваши обращения</div>
        {ticketsQ.isLoading ? (
          <div className="text-sm text-muted-foreground" data-testid="support-tickets-loading">Загрузка…</div>
        ) : tickets.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="support-tickets-empty">
            Обращения появятся здесь после отправки.
          </div>
        ) : (
          <ul className="space-y-3" data-testid="support-tickets-list">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-md bg-muted/50 p-3" data-testid={`support-ticket-${t.id}`}>
                <div className="flex items-center gap-2">
                  <span className="font-light flex-1">{t.subject}</span>
                  <span className="text-xs text-muted-foreground">{fmtDate(t.createdAt)}</span>
                </div>
                <div className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{t.message}</div>
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground mt-2">
                  {t.status === "resolved" ? "Решено" : "Открыто"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
