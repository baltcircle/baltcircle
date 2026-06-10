import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { MapObject, Parking } from "@shared/schema";
import { YandexMap } from "@/components/YandexMap";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Map as MapIcon, Trash2, Save, Eraser, Route as RouteIcon, Hexagon, Crosshair, Eye, EyeOff } from "lucide-react";

const ADMIN_OBJECTS_KEY = ["/api/admin/map-objects"] as const;

type ObjType = "route" | "operating" | "slow" | "forbidden";

const TYPE_OPTIONS: { id: ObjType; label: string; kind: "route" | "zone"; color: string }[] = [
  { id: "route",     label: "Маршрут",            kind: "route", color: "#1d6f8e" },
  { id: "operating", label: "Ограничение парковки", kind: "zone",  color: "#1f9e93" },
  { id: "slow",      label: "Тихая зона (15 км/ч)", kind: "zone", color: "#c9831f" },
  { id: "forbidden", label: "Запрещённая зона",   kind: "zone",  color: "#d64545" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.id, o.label]),
);

export function MapEditorPage() {
  const { toast } = useToast();
  // Admin editor reads the full list (incl. inactive). The public map reads the
  // active-only "/api/map-objects" endpoint, so it stays clean.
  const objectsQ = useQuery<MapObject[]>({ queryKey: ADMIN_OBJECTS_KEY });
  // Managed parkings shown as context so the operator can align routes and
  // zones to the real pickup/return points while drawing. Uses the admin
  // full-list endpoint so inactive points appear (muted) here too — only the
  // public customer map is limited to active parkings.
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/admin/parkings"] });

  const [type, setType] = useState<ObjType>("route");
  const [name, setName] = useState("");
  const [color, setColor] = useState(TYPE_OPTIONS[0].color);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const centerGetterRef = useRef<(() => [number, number]) | null>(null);

  const activeType = TYPE_OPTIONS.find((o) => o.id === type) ?? TYPE_OPTIONS[0];
  const minPoints = activeType.kind === "zone" ? 3 : 2;

  // The draft is rendered as a transient saved-style object so the operator sees
  // the line/polygon update live as they click.
  const draftObject: MapObject | null =
    draft.length >= 2
      ? {
          id: -1,
          name: name || "Черновик",
          type,
          kind: activeType.kind,
          color,
          points: JSON.stringify(draft),
          active: true,
          createdAt: 0,
        }
      : null;

  // Preview mirrors the public map: only active objects render (plus the live
  // draft), so the operator sees exactly what riders will see.
  const previewObjects = [
    ...(objectsQ.data ?? []).filter((o) => o.active),
    ...(draftObject ? [draftObject] : []),
  ];

  // Drop archived (soft-deleted) parkings before drawing. Inactive points stay
  // and are rendered muted by YandexMap.
  const mapParkings = (parkingsQ.data ?? []).filter((p) => !p.archivedAt);

  const saveM = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/map-objects", {
        name: name.trim(),
        type,
        kind: activeType.kind,
        color,
        points: draft,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_OBJECTS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/map-objects"] });
      setDraft([]);
      setName("");
      toast({ title: "Объект сохранён" });
    },
    onError: (e: Error) => toast({ title: "Не удалось сохранить", description: e.message, variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/map-objects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_OBJECTS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/map-objects"] });
      toast({ title: "Объект удалён" });
    },
    onError: (e: Error) => toast({ title: "Не удалось удалить", description: e.message, variant: "destructive" }),
  });

  const toggleM = useMutation({
    mutationFn: async (vars: { id: number; active: boolean }) => {
      await apiRequest("PATCH", `/api/map-objects/${vars.id}`, { active: vars.active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_OBJECTS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/map-objects"] });
    },
    onError: (e: Error) => toast({ title: "Не удалось изменить", description: e.message, variant: "destructive" }),
  });

  // Validate on click instead of disabling the button: a disabled button looks
  // "silently dead" in real browsers, which is exactly the reported bug. We keep
  // the button clickable and explain via a toast what is still required.
  function handleSave() {
    if (saveM.isPending) return;
    if (name.trim().length === 0) {
      toast({
        title: "Введите название",
        description: "Укажите название объекта перед сохранением.",
        variant: "destructive",
      });
      return;
    }
    if (draft.length < minPoints) {
      toast({
        title: "Недостаточно точек",
        description:
          activeType.kind === "zone"
            ? `Для зоны нужно минимум 3 точки. Сейчас: ${draft.length}. Кликайте по карте или используйте «Точка в центре карты».`
            : `Для маршрута нужно минимум 2 точки. Сейчас: ${draft.length}. Кликайте по карте или используйте «Точка в центре карты».`,
        variant: "destructive",
      });
      return;
    }
    saveM.mutate();
  }

  function addCenterPoint() {
    const getCenter = centerGetterRef.current;
    if (!getCenter) {
      toast({
        title: "Карта ещё не готова",
        description: "Подождите, пока загрузится карта, и попробуйте снова.",
        variant: "destructive",
      });
      return;
    }
    setDraft((d) => [...d, getCenter()]);
  }

  function chooseType(id: ObjType) {
    const opt = TYPE_OPTIONS.find((o) => o.id === id)!;
    setType(id);
    setColor(opt.color);
  }

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-map-editor">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Карта</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Редактор карты</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Кликайте по карте, чтобы добавлять точки маршрута или зоны. Сохранённые
          объекты отображаются в клиентском приложении.
        </p>
      </header>

      <div className="grid lg:grid-cols-[1fr_360px] gap-4 lg:gap-6">
        <div>
          <YandexMap
            bikes={[]}
            parkings={mapParkings}
            mapObjects={previewObjects}
            height="64vh"
            onMapClick={(coords) => setDraft((d) => [...d, coords])}
            onCenterGetter={(fn) => { centerGetterRef.current = fn; }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addCenterPoint}
              data-testid="editor-add-center"
            >
              <Crosshair className="w-4 h-4 mr-2" /> Точка в центре карты
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="editor-draft-info">
              Точек в черновике: <span className="font-medium text-foreground">{draft.length}</span>
              {" / "}нужно {minPoints}
              {draft.length > 0 && draft.length < minPoints && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  добавьте ещё {minPoints - draft.length}
                </span>
              )}
              {draft.length >= minPoints && (
                <span className="ml-2 text-emerald-600 dark:text-emerald-400">готово к сохранению</span>
              )}
            </span>
          </div>
        </div>

        <div className="space-y-4">
          {/* Editor controls */}
          <Card className="p-5 space-y-4" data-testid="editor-controls">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Тип объекта</div>
              <div className="grid grid-cols-2 gap-2">
                {TYPE_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => chooseType(o.id)}
                    data-testid={`editor-type-${o.id}`}
                    className={[
                      "flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs text-left hover-elevate",
                      type === o.id ? "border-primary bg-primary/5" : "border-card-border",
                    ].join(" ")}
                  >
                    {o.kind === "route"
                      ? <RouteIcon className="w-3.5 h-3.5 shrink-0" style={{ color: o.color }} />
                      : <Hexagon className="w-3.5 h-3.5 shrink-0" style={{ color: o.color }} />}
                    <span className="font-light leading-tight">{o.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Название</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Напр. Светлогорск → Пионерский"
                className="mt-1"
                data-testid="editor-name"
              />
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">Цвет</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-12 rounded-md border border-card-border bg-transparent p-1"
                  data-testid="editor-color"
                />
                <span className="text-xs text-muted-foreground">{color}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={handleSave}
                disabled={saveM.isPending}
                data-testid="editor-save"
              >
                <Save className="w-4 h-4 mr-2" /> {saveM.isPending ? "Сохранение…" : "Сохранить"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDraft([])}
                disabled={draft.length === 0}
                data-testid="editor-clear"
              >
                <Eraser className="w-4 h-4 mr-2" /> Очистить черновик
              </Button>
            </div>
          </Card>

          {/* Saved objects list */}
          <Card className="p-5" data-testid="editor-saved-list">
            <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-widest text-muted-foreground">
              <MapIcon className="w-3.5 h-3.5" /> Сохранённые объекты
              <span className="ml-auto normal-case tracking-normal text-foreground">
                {objectsQ.data?.length ?? 0}
              </span>
            </div>
            {(objectsQ.data?.length ?? 0) === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="editor-saved-empty">
                Пока нет объектов. Карта в приложении пустая.
              </div>
            ) : (
              <div className="space-y-2">
                {objectsQ.data!.map((o) => (
                  <div
                    key={o.id}
                    className={[
                      "flex items-center gap-2 rounded-md border border-card-border px-3 py-2",
                      o.active ? "" : "opacity-60",
                    ].join(" ")}
                    data-testid={`editor-saved-${o.id}`}
                  >
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: o.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-light truncate">{o.name}</div>
                      <div className="text-[11px] text-muted-foreground">{TYPE_LABEL[o.type] ?? o.type}</div>
                    </div>
                    <Badge variant="secondary" className="text-[10px]">{o.kind === "zone" ? "зона" : "линия"}</Badge>
                    {!o.active && (
                      <Badge variant="outline" className="text-[10px]" data-testid={`editor-inactive-${o.id}`}>
                        скрыт
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => toggleM.mutate({ id: o.id, active: !o.active })}
                      disabled={toggleM.isPending}
                      data-testid={`editor-toggle-${o.id}`}
                      aria-label={o.active ? "Скрыть с карты" : "Показать на карте"}
                      title={o.active ? "Скрыть с публичной карты" : "Показать на публичной карте"}
                    >
                      {o.active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4 text-muted-foreground" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => deleteM.mutate(o.id)}
                      disabled={deleteM.isPending}
                      data-testid={`editor-delete-${o.id}`}
                      aria-label="Удалить объект"
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
