import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Wallet, Payment } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { fmtRub, fmtDate } from "@/lib/format";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import { Wallet as WalletIcon, CreditCard, Plus, Check, Sparkles, Receipt, ShieldCheck } from "lucide-react";

const tariffDurations: Record<string, number> = {
  payg: 0,
  day: 24 * 3600 * 1000,
  month: 30 * 24 * 3600 * 1000,
};

export function TariffsPage() {
  const toast = useToast();
  const walletQ = useQuery<Wallet>({ queryKey: ["/api/wallet"] });
  const paymentsQ = useQuery<Payment[]>({ queryKey: ["/api/payments"] });

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmount, setTopupAmount] = useState(500);
  const [confirmTariff, setConfirmTariff] = useState<null | Tariff>(null);

  const topupMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wallet/topup", { amount: topupAmount });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      setTopupOpen(false);
      toast.toast({ title: "Баланс пополнен", description: `+${fmtRub(topupAmount)}` });
    },
  });

  const buyMut = useMutation({
    mutationFn: async (t: Tariff) => {
      const res = await apiRequest("POST", "/api/wallet/tariff", {
        tariff: t.id,
        price: t.price,
        durationMs: tariffDurations[t.id],
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      setConfirmTariff(null);
      toast.toast({ title: "Тариф подключён" });
    },
    onError: (err: any) => {
      toast.toast({ title: "Не удалось подключить", description: err?.message ?? "Ошибка", variant: "destructive" });
    },
  });

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-6xl mx-auto" data-testid="page-tariffs">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Тарифы и баланс</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Платите как удобно</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Поминутно для редких поездок, дневной для прогулки, месячный для постоянных маршрутов на работу или учёбу.
        </p>
      </header>

      {/* Wallet card */}
      <Card className="p-6 mb-8 bg-gradient-to-br from-primary to-primary/80 text-primary-foreground overflow-hidden relative" data-testid="card-wallet">
        <div className="absolute -right-12 -bottom-12 opacity-10">
          <WalletIcon className="w-64 h-64" />
        </div>
        <div className="relative z-10 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] opacity-80">Доступно</div>
            <div className="font-display text-4xl font-light mt-1" data-testid="text-wallet-balance">
              {fmtRub(walletQ.data?.balance ?? 0)}
            </div>
            <div className="mt-2 text-xs opacity-80 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" />
              Активный тариф: <span className="font-medium">{tariffLabel(walletQ.data?.activeTariff ?? "payg")}</span>
              {walletQ.data?.tariffExpiresAt ? <span className="opacity-70">· до {fmtDate(walletQ.data.tariffExpiresAt)}</span> : null}
            </div>
          </div>
          <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
            <DialogTrigger asChild>
              <Button className="bg-white/15 hover:bg-white/25 backdrop-blur border border-white/20 text-primary-foreground" data-testid="button-open-topup">
                <Plus className="w-4 h-4 mr-2" /> Пополнить
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="font-display font-light">Пополнение баланса</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {[200, 500, 1000].map(v => (
                    <Button key={v} variant={topupAmount === v ? "default" : "outline"} onClick={() => setTopupAmount(v)} data-testid={`button-preset-${v}`}>
                      {fmtRub(v)}
                    </Button>
                  ))}
                </div>
                <Input
                  type="number"
                  value={topupAmount}
                  onChange={e => setTopupAmount(Math.max(0, Number(e.target.value)))}
                  data-testid="input-topup-amount"
                />
                <div className="rounded-md bg-muted/60 p-3 text-sm flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-muted-foreground" />
                  <span className="font-mono">•••• •••• •••• 4242</span>
                  <span className="ml-auto text-xs text-muted-foreground">Visa</span>
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Платёж имитируется. Деньги не списываются.
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => topupMut.mutate()} disabled={topupMut.isPending} data-testid="button-confirm-topup">
                  Оплатить {fmtRub(topupAmount)}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </Card>

      {/* Tariff plans */}
      <div className="grid md:grid-cols-3 gap-4 mb-10">
        {TARIFFS.map(t => {
          const isActive = walletQ.data?.activeTariff === t.id;
          return (
            <Card key={t.id}
              className={`p-6 relative overflow-hidden ${t.popular ? "border-primary/40 ring-1 ring-primary/30" : ""}`}
              data-testid={`card-tariff-${t.id}`}
            >
              {t.popular && (
                <Badge className="absolute top-4 right-4 bg-accent text-accent-foreground border-0">Популярный</Badge>
              )}
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{t.id === "payg" ? "Поминутно" : t.id === "day" ? "Сутки" : "Месяц"}</div>
              <div className="font-display text-2xl font-light mt-1">{t.name}</div>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="font-display text-4xl font-light">{t.price}</span>
                <span className="text-muted-foreground text-sm">{t.unit}</span>
              </div>
              <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{t.description}</p>
              <Button
                className="mt-5 w-full"
                variant={isActive ? "outline" : "default"}
                disabled={isActive}
                onClick={() => setConfirmTariff(t)}
                data-testid={`button-select-${t.id}`}
              >
                {isActive ? <><Check className="w-4 h-4 mr-2" />Активен</> : t.id === "payg" ? "Перейти на этот режим" : "Подключить"}
              </Button>
            </Card>
          );
        })}
      </div>

      <Dialog open={!!confirmTariff} onOpenChange={(o) => !o && setConfirmTariff(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display font-light">Подтверждение</DialogTitle>
          </DialogHeader>
          {confirmTariff && (
            <div className="space-y-3 text-sm">
              <div>Тариф <b>{confirmTariff.name}</b> будет подключён прямо сейчас.</div>
              <div className="flex justify-between p-3 rounded-md bg-muted/60">
                <span>К списанию с баланса</span>
                <b>{fmtRub(confirmTariff.price)}</b>
              </div>
              <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3" /> Списание имитируется.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTariff(null)} data-testid="button-cancel-tariff">Отмена</Button>
            <Button onClick={() => confirmTariff && buyMut.mutate(confirmTariff)} disabled={buyMut.isPending} data-testid="button-confirm-tariff">
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recent payments */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Receipt className="w-4 h-4 text-muted-foreground" />
          <h2 className="font-display text-lg font-light">История платежей</h2>
        </div>
        <Card className="divide-y divide-card-border" data-testid="list-payments">
          {(paymentsQ.data ?? []).slice(0, 12).map(p => (
            <div key={p.id} className="flex items-center justify-between px-4 py-3" data-testid={`row-payment-${p.id}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{p.description}</div>
                <div className="text-xs text-muted-foreground">{fmtDate(p.createdAt)}</div>
              </div>
              <div className={`font-mono text-sm ${p.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
                {p.amount > 0 ? "+" : ""}{fmtRub(p.amount)}
              </div>
            </div>
          ))}
          {(paymentsQ.data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground p-6 text-center">Пока нет платежей.</div>
          )}
        </Card>
      </section>
    </div>
  );
}

function tariffLabel(t: string) {
  return t === "day" ? "Дневной" : t === "month" ? "Месячный" : "По минутам";
}
