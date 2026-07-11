import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { MapObject, Parking } from "@shared/schema";
import { MapLibreMap } from "@/components/MapLibreMap";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Map as MapIcon,
  Trash2,
  Save,
  Eraser,
  Route as RouteIcon,
  Hexagon,
  Undo2,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronLeft,
  Check,
  CircleDot,
  Info,
  Pencil,
  X,
} from "lucide-react";

const ADMIN_OBJECTS_KEY = ["/api/admin/map-objects"] as const;

type ObjType = "route" | "operating" | "slow" | "forbidden";
type Kind = "route" | "zone";

interface TypeOption {
  id: ObjType;
  label: string;
  short: string;
  kind: Kind;
  color: string;
  desc: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  { id: "route",     label: "Маршрут",              short: "Маршрут",   kind: "route", color: "#1d6f8e", desc: "Линия — рекомендованный трек" },
  { id: "operating", label: "Ограничение парковки", short: "Парковка",  kind: "zone",  color: "#1f9e93", desc: "Полигон — только внутри разрешено парковаться" },
  { id: "slow",      label: "Тихая зона (15 км/ч)", short: "Тихая",     kind: "zone",  color: "#c9831f", desc: "Полигон — принудительное ограничение скорости" },
  { id: "forbidden", label: "Запрещённая зона",     short: "Запрет",    kind: "zone",  color: "#d64545", desc: "Полигон — езда запрещена" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.id, o.label]),
);

export function MapEditorPage() {
  const { toast } = useToast();
  const objectsQ = useQuery<MapObject[]>({ queryKey: ADMIN_OBJECTS_KEY });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/admin/parkings"] });

  const [type, setType] = useState<ObjType>("route");
  const [name, setName] = useState("");
  const [color, setColor] = useState(TYPE_OPTIONS[0].color);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  const activeType = TYPE_OPTIONS.find((o) => o.id === type) ?? TYPE_OPTIONS[0];
  const minPoints = activeType.kind === "zone" ? 3 : 2;
  const canSave = draft.length >= minPoints && name.trim().length > 0;

  // Public map отображает только активные; если что-то редактируется — его
  // старую геометрию скрываем, чтобы не дублировать черновик.
  const previewObjects = useMemo(
    () => (objectsQ.data ?? []).filter((o) => o.active && o.id !== editingId),
    [objectsQ.data, editingId],
  );
  const mapParkings = useMemo(() => (parkingsQ.data ?? []).filter((p) => !p.archivedAt), [parkingsQ.data]);

  // Undo по Ctrl/⌘+Z.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        type,
        kind: activeType.kind,
        color,
        points: draft,
      };
      const res = editingId !== null
        ? await apiRequest("PATCH", `/api/map-objects/${editingId}`, payload)
        : await apiRequest("POST", "/api/map-objects", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_OBJECTS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/map-objects"] });
      const wasEditing = editingId !== null;
      setDraft([]);
      setName("");
      setEditingId(null);
      toast({ title: wasEditing ? "Изменения сохранены" : "Объект сохранён" });
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

  function handleSave() {
    if (saveM.isPending) return;
    if (name.trim().length === 0) {
      toast({ title: "Введите название", description: "Укажите название объекта перед сохранением.", variant: "destructive" });
      return;
    }
    if (draft.length < minPoints) {
      toast({
        title: "Недостаточно точек",
        description: activeType.kind === "zone"
          ? `Для зоны нужно минимум 3 точки. Сейчас: ${draft.length}.`
          : `Для маршрута нужно минимум 2 точки. Сейчас: ${draft.length}.`,
        variant: "destructive",
      });
      return;
    }
    saveM.mutate();
  }

  function chooseType(id: ObjType) {
    const opt = TYPE_OPTIONS.find((o) => o.id === id)!;
    setType(id);
    setColor(opt.color);
    // Если меняем kind (route↔zone) и уже есть точки — предупреждаем.
    if (draft.length > 0 && opt.kind !== activeType.kind) {
      toast({ title: "Тип изменён", description: "Черновик сохранён; учтите: минимальное число точек могло измениться." });
    }
  }

  function startEdit(o: MapObject) {
    if (draft.length > 0 && !window.confirm("Отменить текущий черновик и начать редактирование?")) return;
    setEditingId(o.id);
    setType(o.type as ObjType);
    setColor(o.color);
    setName(o.name);
    setDraft((o.points as [number, number][]).slice());
    setPanelOpen(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft([]);
    setName("");
  }

  function handleVertexClick(index: number) {
    // Клик по первой точке зоны — замыкаем и сразу сохраняем, если есть имя.
    if (index === 0 && activeType.kind === "zone" && draft.length >= 3) {
      if (name.trim().length === 0) {
        toast({
          title: "Зона замкнута",
          description: "Введите название и нажмите «Сохранить».",
        });
        return;
      }
      handleSave();
      return;
    }
    // Клик по последней добавленной — удаляем (быстрая отмена).
    if (index === draft.length - 1) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    // Клик по любой другой вершине — удаляем её.
    setDraft((d) => d.filter((_, i) => i !== index));
  }

  return (
    <div className="relative h-[calc(100dvh-56px)] lg:h-[calc(100dvh)] w-full overflow-hidden bg-background" data-testid="page-map-editor">
      {/* Карта во весь экран */}
      <MapLibreMap
        parkings={mapParkings}
        mapObjects={previewObjects}
        height="100%"
        className="absolute inset-0"
        onMapClick={(coords) => setDraft((d) => [...d, coords])}
        editorDraft={{
          points: draft,
          kind: activeType.kind,
          color,
          onVertexClick: handleVertexClick,
          onVertexDrag: (index, coords) =>
            setDraft((d) => d.map((p, i) => (i === index ? coords : p))),
        }}
      />

      {/* ── Верхний тулбар: выбор типа ─────────────────────────────────────── */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 w-[min(720px,calc(100%-24px))]">
        <Card className="p-2 flex items-center gap-1 shadow-lg backdrop-blur bg-background/95">
          {TYPE_OPTIONS.map((o) => {
            const active = o.id === type;
            return (
              <button
                key={o.id}
                onClick={() => chooseType(o.id)}
                data-testid={`editor-type-${o.id}`}
                title={o.desc}
                className={[
                  "flex-1 flex flex-col items-center gap-1 rounded-md px-2 py-2 text-[11px] transition",
                  active ? "bg-primary/10 border border-primary" : "border border-transparent hover:bg-muted",
                ].join(" ")}
              >
                <span className="flex items-center gap-1.5">
                  {o.kind === "route"
                    ? <RouteIcon className="w-3.5 h-3.5" style={{ color: o.color }} />
                    : <Hexagon className="w-3.5 h-3.5" style={{ color: o.color }} />}
                  <span className="font-medium leading-tight">{o.short}</span>
                </span>
                <span className="text-[9px] text-muted-foreground leading-tight text-center hidden md:block">
                  {o.desc.split(" — ")[1] ?? ""}
                </span>
              </button>
            );
          })}
        </Card>
      </div>

      {/* ── Нижний плавающий тулбар: рисование ─────────────────────────────── */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(760px,calc(100%-24px))]">
        {editingId !== null && (
          <div className="mb-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs shadow-lg flex items-center gap-2" data-testid="editor-editing-badge">
            <Pencil className="w-3 h-3" />
            <span className="truncate">Редактирование: {name || `#${editingId}`}</span>
            <button onClick={cancelEdit} className="ml-auto opacity-80 hover:opacity-100 flex items-center gap-1 shrink-0" title="Отменить">
              <X className="w-3 h-3" />Отмена
            </button>
          </div>
        )}
        <Card className="px-3 py-3 shadow-lg backdrop-blur bg-background/95">
          <div className="flex items-center gap-2 mb-3">
            <div
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }}
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Название · напр. «${activeType.kind === "zone" ? "Пляж Светлогорска" : "Пионерский → Янтарный"}»`}
              className="h-9 text-sm"
              data-testid="editor-name"
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-9 rounded-md border border-card-border bg-transparent p-1 shrink-0"
              data-testid="editor-color"
              title="Цвет объекта"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DraftInfo
              draft={draft}
              minPoints={minPoints}
              kind={activeType.kind}
            />

            <div className="ml-auto flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft((d) => d.slice(0, -1))}
                disabled={draft.length === 0}
                data-testid="editor-undo"
                title="Отменить последнюю точку (Ctrl/⌘+Z)"
              >
                <Undo2 className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={editingId !== null ? cancelEdit : () => setDraft([])}
                disabled={draft.length === 0 && editingId === null}
                data-testid="editor-clear"
                title={editingId !== null ? "Отменить редактирование" : "Очистить черновик"}
              >
                {editingId !== null ? <X className="w-4 h-4" /> : <Eraser className="w-4 h-4" />}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={saveM.isPending || !canSave}
                data-testid="editor-save"
                className="min-w-[110px]"
              >
                <Save className="w-4 h-4 mr-1.5" />
                {saveM.isPending ? "Сохр…" : (editingId !== null ? "Обновить" : "Сохранить")}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* ── Правая панель: сохранённые объекты ─────────────────────────────── */}
      <div
        className={[
          "absolute top-3 right-3 bottom-3 z-20 w-[320px] max-w-[80vw] transition-transform duration-200",
          panelOpen ? "translate-x-0" : "translate-x-[calc(100%+12px)]",
        ].join(" ")}
      >
        <Card className="h-full p-4 shadow-lg backdrop-blur bg-background/95 flex flex-col" data-testid="editor-saved-list">
          <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-widest text-muted-foreground">
            <MapIcon className="w-3.5 h-3.5" /> Сохранённые
            <span className="ml-auto normal-case tracking-normal text-foreground text-sm">
              {objectsQ.data?.length ?? 0}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 -mx-1 px-1">
            {(objectsQ.data?.length ?? 0) === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="editor-saved-empty">
                Пока нет объектов. Карта в приложении пустая.
              </div>
            ) : (
              objectsQ.data!.map((o) => (
                <div
                  key={o.id}
                  className={[
                    "flex items-center gap-2 rounded-md border border-card-border px-2.5 py-2 group",
                    o.active ? "" : "opacity-60",
                  ].join(" ")}
                  data-testid={`editor-saved-${o.id}`}
                >
                  <span className="w-3 h-3 rounded-sm shrink-0 shadow-inner" style={{ backgroundColor: o.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-light truncate" title={o.name}>{o.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{TYPE_LABEL[o.type] ?? o.type}</div>
                  </div>
                  <Badge variant="secondary" className="text-[9px] px-1.5 h-4">
                    {o.kind === "zone" ? "зона" : "линия"}
                  </Badge>
                  {!o.active && (
                    <Badge variant="outline" className="text-[9px] px-1.5 h-4" data-testid={`editor-inactive-${o.id}`}>
                      скрыт
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => startEdit(o)}
                    data-testid={`editor-edit-${o.id}`}
                    aria-label="Редактировать объект"
                    title="Редактировать"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => toggleM.mutate({ id: o.id, active: !o.active })}
                    disabled={toggleM.isPending}
                    data-testid={`editor-toggle-${o.id}`}
                    aria-label={o.active ? "Скрыть с карты" : "Показать на карте"}
                    title={o.active ? "Скрыть с публичной карты" : "Показать на публичной карте"}
                  >
                    {o.active ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      if (window.confirm(`Удалить «${o.name}»?`)) deleteM.mutate(o.id);
                    }}
                    disabled={deleteM.isPending}
                    data-testid={`editor-delete-${o.id}`}
                    aria-label="Удалить объект"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              ))
            )}
          </div>

          <HintBlock kind={activeType.kind} />
        </Card>

        {/* Кнопка сворачивания панели */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="absolute top-4 -left-9 h-9 w-9 rounded-l-md bg-background/95 border border-r-0 border-card-border shadow-md flex items-center justify-center hover:bg-muted transition"
          data-testid="editor-toggle-panel"
          title={panelOpen ? "Свернуть панель" : "Развернуть панель"}
        >
          {panelOpen ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function DraftInfo({ draft, minPoints, kind }: { draft: [number, number][]; minPoints: number; kind: Kind }) {
  const need = Math.max(0, minPoints - draft.length);
  const ready = draft.length >= minPoints;
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="editor-draft-info">
      <CircleDot className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">
        Точек: <span className="font-medium text-foreground">{draft.length}</span>
        <span className="text-muted-foreground/70"> / {minPoints}</span>
      </span>
      {need > 0 && (
        <span className="text-amber-600 dark:text-amber-400 font-medium">
          нужно ещё {need}
        </span>
      )}
      {ready && (
        <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
          <Check className="w-3 h-3" />
          {kind === "zone" ? "можно замыкать" : "готово"}
        </span>
      )}
    </div>
  );
}

function HintBlock({ kind }: { kind: Kind }) {
  return (
    <div className="mt-3 pt-3 border-t border-card-border text-[11px] text-muted-foreground space-y-1.5">
      <div className="flex items-center gap-1.5 text-foreground font-medium">
        <Info className="w-3 h-3" /> Как рисовать
      </div>
      <div>• Клик по карте — добавить точку</div>
      <div>• Перетащи вершину — переместить точку</div>
      {kind === "zone" ? (
        <div>• Клик по первой точке ◎ — замкнуть зону и сохранить</div>
      ) : null}
      <div>• Клик по любой вершине — убрать её из линии</div>
      <div>• Ctrl/⌘+Z — отменить последнюю точку</div>
    </div>
  );
}
