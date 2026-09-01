import { Link } from "wouter";
import type { Bike, Parking, AdminRide, Ticket } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtDate, fmtRub } from "@/lib/format";
import { X, ExternalLink } from "lucide-react";

const BIKE_STATUS_LABEL: Record<string, string> = {
  available: "Доступен",
  rented: "В аренде",
  reserved: "Забронирован",
  maintenance: "Сервис",
  offline: "Оффлайн",
  storage: "Склад",
  lost: "Потерян",
  archived: "Архив",
};

const TICKET_PRIORITY_LABEL: Record<string, string> = {
  low: "низкий",
  medium: "средний",
  high: "высокий",
  critical: "критический",
};

export type Selection =
  | { kind: "bike"; id: string }
  | { kind: "parking"; id: string }
  | { kind: "ride"; id: number }
  | { kind: "ticket"; id: number }
  | null;

export function DetailCard({ selection, onClose, bikes, parkings, rides, tickets }: {
  selection: Selection;
  onClose: () => void;
  bikes: Bike[];
  parkings: Parking[];
  rides: AdminRide[];
  tickets: Ticket[];
}) {
  if (!selection) return null;

  let title: string;
  let body: React.ReactNode;
  let href: string;
  let linkLabel: string;

  if (selection.kind === "bike") {
    const b = bikes.find((x) => x.id === selection.id);
    if (!b) return null;
    title = `Велосипед ${b.id}`;
    href = "/admin/bikes"; linkLabel = "К велосипедам";
    body = (
      <>
        <Detail label="Модель" value={b.model} />
        <Detail label="Статус" value={BIKE_STATUS_LABEL[b.status] ?? b.status} />
        <Detail label="Заряд" value={`${b.battery}%`} />
        {b.parkingId && <Detail label="Парковка" value={b.parkingId} />}
      </>
    );
  } else if (selection.kind === "parking") {
    const p = parkings.find((x) => x.id === selection.id);
    if (!p) return null;
    title = p.name;
    href = "/admin/parkings"; linkLabel = "К парковкам";
    body = (
      <>
        <Detail label="Код" value={p.id} />
        <Detail label="Статус" value={p.status === "active" ? "Активна" : "Неактивна"} />
        <Detail label="Занято / вмест." value={`${p.occupied} / ${p.capacity}`} />
      </>
    );
  } else if (selection.kind === "ride") {
    const r = rides.find((x) => x.id === selection.id);
    if (!r) return null;
    title = `Поездка #${r.id}`;
    href = "/admin/rides"; linkLabel = "К поездкам";
    body = (
      <>
        <Detail label="Велосипед" value={r.bikeId} />
        <Detail label="Райдер" value={r.userName ?? r.userId} />
        <Detail label="Начало" value={fmtDate(r.startedAt)} />
        <Detail label="Стоимость" value={fmtRub(r.cost)} />
      </>
    );
  } else {
    const t = tickets.find((x) => x.id === selection.id);
    if (!t) return null;
    title = `Тикет #${t.id}`;
    href = "/admin/maintenance"; linkLabel = "К сервису";
    body = (
      <>
        <Detail label="Велосипед" value={t.bikeId} />
        <Detail label="Тема" value={t.title || t.kind} />
        <Detail label="Приоритет" value={TICKET_PRIORITY_LABEL[t.priority] ?? t.priority} />
        <Detail label="Статус" value={t.status} />
      </>
    );
  }

  return (
    <Card className="p-4" data-testid="operations-detail-card">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="font-display text-lg font-light">{title}</div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} data-testid="button-operations-detail-close" aria-label="Закрыть">
          <X className="w-4 h-4" />
        </Button>
      </div>
      <div className="space-y-1.5 mb-4">{body}</div>
      <Link href={href} data-testid="link-operations-detail">
        <Button variant="outline" size="sm" className="w-full">
          <ExternalLink className="w-4 h-4 mr-2" /> {linkLabel}
        </Button>
      </Link>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-light text-right">{value}</span>
    </div>
  );
}
