import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SupportTicketWithUser, SupportTicketStatus } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { LifeBuoy, CheckCircle2, RotateCcw, Phone, User as UserIcon } from "lucide-react";
import { fmtRelative } from "@/lib/format";

const QUERY_KEY = ["/api/admin/support/tickets"];

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open: "Открыта",
  resolved: "Решена",
};

export function SupportInboxPage() {
  const toast = useToast();
  const listQ = useQuery<SupportTicketWithUser[]>({ queryKey: QUERY_KEY });
  const tickets = listQ.data ?? [];

  const [statusFilter, setStatusFilter] = useState<"all" | SupportTicketStatus>("open");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (q) {
        const hay = `${t.subject} ${t.message} ${t.userName ?? ""} ${t.userPhone ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, statusFilter, query]);

  const openCount = tickets.filter((t) => t.status === "open").length;

  const updateMut = useMutation<
    SupportTicketWithUser,
    Error,
    { id: number; status: SupportTicketStatus }
  >({
    mutationFn: async ({ id, status }) => {
      const res = await apiRequest("PATCH", `/api/admin/support/tickets/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e) =>
      toast.toast({
        title: "Не удалось обновить заявку",
        description: e?.message?.replace(/^\d+:\s*/, "") ?? String(e),
        variant: "destructive",
      }),
  });

  function setStatus(id: number, status: SupportTicketStatus) {
    updateMut.mutate({ id, status });
  }

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-5xl mx-auto" data-testid="page-admin-support">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Поддержка</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1 flex items-center gap-2">
            <LifeBuoy className="w-6 h-6 text-primary" />
            Обращения пользователей
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {openCount} открытых из {tickets.length}. Вопросы и жалобы, отправленные из раздела «Помощь».
          </p>
        </div>
      </header>

      <Card className="p-4 mb-4" data-testid="support-filters">
        <div className="grid gap-3 md:grid-cols-2 items-end">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Поиск</div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Тема, текст, имя, телефон"
              data-testid="input-support-search"
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Статус</div>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
              <SelectTrigger data-testid="select-support-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все</SelectItem>
                <SelectItem value="open">Открытые</SelectItem>
                <SelectItem value="resolved">Решённые</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      {listQ.isLoading ? (
        <Card className="p-8 text-sm text-muted-foreground text-center" data-testid="support-loading">
          Загружаем заявки…
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center" data-testid="support-empty">
          <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-2" />
          <div className="text-sm text-muted-foreground">
            {statusFilter === "open" ? "Открытых обращений нет." : "Ничего не найдено."}
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <Card key={t.id} className="p-4" data-testid={`support-ticket-${t.id}`}>
              <div className="flex items-start gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{t.subject}</span>
                    <Badge
                      variant="outline"
                      className={t.status === "open"
                        ? "text-amber-600 dark:text-amber-400 border-amber-500/40"
                        : "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"}
                    >
                      {STATUS_LABEL[t.status as SupportTicketStatus] ?? t.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">#{t.id}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{fmtRelative(t.createdAt)}</span>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{t.message}</div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                    {t.userName && (
                      <span className="inline-flex items-center gap-1" data-testid={`support-user-${t.id}`}>
                        <UserIcon className="w-3.5 h-3.5" />{t.userName}
                      </span>
                    )}
                    {t.userPhone && (
                      <a
                        href={`tel:${t.userPhone}`}
                        className="inline-flex items-center gap-1 hover:text-primary"
                        data-testid={`support-phone-${t.id}`}
                      >
                        <Phone className="w-3.5 h-3.5" />{t.userPhone}
                      </a>
                    )}
                  </div>
                </div>
                <div className="shrink-0">
                  {t.status === "open" ? (
                    <Button
                      size="sm"
                      onClick={() => setStatus(t.id, "resolved")}
                      disabled={updateMut.isPending}
                      data-testid={`button-support-resolve-${t.id}`}
                    >
                      <CheckCircle2 className="w-4 h-4 mr-1.5" />Решено
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setStatus(t.id, "open")}
                      disabled={updateMut.isPending}
                      data-testid={`button-support-reopen-${t.id}`}
                    >
                      <RotateCcw className="w-4 h-4 mr-1.5" />Переоткрыть
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
