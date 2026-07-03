import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Bike, Ride } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ActiveRidePanel } from "@/components/ActiveRidePanel";
import { RegistrationModal } from "@/components/RegistrationModal";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useActiveRideStream } from "@/hooks/use-active-ride-stream";
import { QrCode, Camera, Battery, MapPin, Clock, Sparkles } from "lucide-react";

export function RentPage() {
  const [loc] = useLocation();
  const toast = useToast();
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const activeQ = useQuery<Ride | null>({ queryKey: ["/api/rides/active"] });
  // Live active-ride updates via SSE (replaces the old 4s poll).
  useActiveRideStream();
  const { isRegistered } = useCurrentUser();

  const [scanState, setScanState] = useState<"idle" | "scanning" | "success" | "error">("idle");
  const [code, setCode] = useState("");
  const [regOpen, setRegOpen] = useState(false);

  // Preselect from query. Clean URLs carry "?bike=" on the real URL; legacy
  // hash links ("/#/rent?bike=...") still parse so old bookmarks keep working.
  useEffect(() => {
    const u = new URL(window.location.href);
    let bike = u.searchParams.get("bike");
    if (!bike && u.hash.includes("?")) {
      const hashQuery = new URLSearchParams(u.hash.slice(u.hash.indexOf("?")));
      bike = hashQuery.get("bike");
    }
    if (bike) setCode(bike);
  }, [loc]);

  const startMut = useMutation<Ride, Error, string>({
    mutationFn: async (bikeId: string) => {
      const res = await apiRequest("POST", "/api/rides/start", { bikeId, tariff: "h1" });
      return res.json();
    },
    onSuccess: () => {
      setScanState("success");
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({ title: "Поездка начата", description: "Замок разблокирован, можно ехать!" });
    },
    onError: (err: any) => {
      setScanState("error");
      toast.toast({ title: "Не удалось начать поездку", description: err?.message ?? "Ошибка", variant: "destructive" });
    },
  });

  function startScan(skipGate = false) {
    // Registration gate: unregistered riders must register before scanning.
    // skipGate is used to resume right after a successful registration, when
    // the cached isRegistered flag may not have refreshed in this closure yet.
    if (!skipGate && !isRegistered) {
      setRegOpen(true);
      return;
    }
    setScanState("scanning");
    const candidate = code.trim() || pickAvailable(bikesQ.data ?? []);
    setTimeout(() => {
      if (!candidate) {
        setScanState("error");
        toast.toast({ title: "QR не распознан", description: "Не нашли доступный велосипед", variant: "destructive" });
        return;
      }
      setCode(candidate);
      startMut.mutate(candidate);
    }, 1400);
  }

  if (activeQ.data) {
    return <ActiveRidePanel ride={activeQ.data} />;
  }

  const bike = bikesQ.data?.find(b => b.id === code.trim().toUpperCase());

  return (
    <>
    <RegistrationModal
      open={regOpen}
      onOpenChange={setRegOpen}
      onRegistered={() => startScan(true)}
    />
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-5xl mx-auto" data-testid="page-rent">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Аренда</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Сканируйте QR-код на руле</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Наведите камеру на код или введите номер вручную с наклейки рамы. Замок разблокируется автоматически, и поездка начнётся.
        </p>
      </header>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6">
        {/* Scanner */}
        <Card className="relative aspect-square max-h-[520px] flex items-center justify-center overflow-hidden bg-gradient-to-br from-primary to-primary/70 text-primary-foreground">
          <div className="absolute inset-6 rounded-xl border border-white/40" />
          <div className="absolute inset-12 rounded-lg border-2 border-white/60 scan-line overflow-hidden" data-testid="scanner-frame" />
          {/* Corner markers */}
          {[[10,10,0], [10,10,90], [10,10,180], [10,10,270]].map(([x,y,rot], i) => (
            <svg key={i} className="absolute" style={{ transform: `rotate(${rot}deg)`, top: i < 2 ? 24 : "auto", bottom: i >= 2 ? 24 : "auto", left: i % 2 === 0 ? 24 : "auto", right: i % 2 === 1 ? 24 : "auto" }} width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <path d="M0 10 V0 H10" stroke="white" strokeWidth="2.5" fill="none" />
            </svg>
          ))}
          <div className="relative z-10 text-center px-6">
            <QrCode className="w-12 h-12 mx-auto opacity-90" />
            <div className="mt-3 font-display text-lg font-light tracking-wide">
              {scanState === "scanning" ? "Сканирование…" :
               scanState === "success" ? "QR принят" :
               scanState === "error" ? "QR не принят" :
               "Готов к сканированию"}
            </div>
            <div className="opacity-80 text-xs mt-1">Имитация камеры для веб-MVP</div>
          </div>
        </Card>

        {/* Right column: input + bike preview + payment summary */}
        <div className="space-y-4">
          <Card className="p-5">
            <div className="text-sm font-medium mb-2">Код велосипеда</div>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder="BC-014"
                data-testid="input-bike-code"
                className="font-mono"
              />
              <Button onClick={() => startScan()} disabled={scanState === "scanning" || startMut.isPending} data-testid="button-start-scan">
                <Camera className="w-4 h-4 mr-2" />
                Сканировать
              </Button>
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              Подсказка: при пустом поле система выберет ближайший доступный велосипед.
            </div>
          </Card>

          {bike && (
            <Card className="p-5" data-testid="card-bike-preview">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Найден</div>
                  <div className="font-display text-xl font-light">{bike.id}</div>
                  <div className="text-sm text-muted-foreground">{bike.model}</div>
                </div>
                <Badge>{bike.status === "available" ? "Доступен" : bike.status}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
                <Mini icon={<Battery className="w-4 h-4" />} label="Замок" value={`${bike.battery}%`} />
                <Mini icon={<MapPin className="w-4 h-4" />} label="Простой" value={`${bike.idleHours.toFixed(1)} ч`} />
              </div>
            </Card>
          )}

          <Card className="p-5" data-testid="card-payment-summary">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="font-medium">Оплата картой / СБП</span>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Стоимость поездки спишется с привязанного способа оплаты. Привязать карту можно в профиле.
            </div>
          </Card>

          <ul className="text-xs text-muted-foreground space-y-1.5 px-1" data-testid="rent-help">
            <li className="flex gap-2"><Clock className="w-3 h-3 mt-0.5" />Бронь сохраняется 5 минут.</li>
            <li className="flex gap-2"><MapPin className="w-3 h-3 mt-0.5" />Завершайте поездку на парковке TakeRide, иначе будет штраф 100 ₽.</li>
            <li className="flex gap-2"><Sparkles className="w-3 h-3 mt-0.5" />В тихих зонах скорость ограничена до 15 км/ч.</li>
          </ul>
        </div>
      </div>
    </div>
    </>
  );
}

function pickAvailable(bikes: Bike[]) {
  const a = bikes.find(b => b.status === "available");
  return a?.id ?? "";
}
function Mini({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-card-border bg-background/50 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">{icon} {label}</div>
      <div className="font-display text-base font-light mt-0.5">{value}</div>
    </div>
  );
}
