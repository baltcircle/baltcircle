import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { MapObject } from "@shared/schema";
import { YandexMap } from "@/components/YandexMap";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Map as MapIcon, Trash2, Save, Eraser, Route as RouteIcon, Hexagon } from "lucide-react";

type ObjType = "route" | "operating" | "slow" | "forbidden";

const TYPE_OPTIONS: { id: ObjType; label: string; kind: "route" | "zone"; color: string }[] = [
  { id: "route",     label: "Маршрут",            kind: "route", color: "#1d6f8e" },
  { id: "operating", label: "Зона обслуживания",  kind: "zone",  color: "#1f9e93" },
  { id: "slow",      label: "Тихая зона (15 км/ч)", kind: "zone", color: "#c9831f" },
  { id: "forbidden", label: "Запрещённая зона",   kind: "zone",  color: "#d64545" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.id, o.label]),
);

export function MapEditorPage() {
  const { toast } = useToast();
  const objectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });

  const [type, setType] = useState<ObjType>("route");
  const [name, setName] = useState("");
  const [color, setColor] = useState(TYPE_OPTIONS[0].color);
  const [draft, setDraft] = useState<[number, number][]>([]);

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
          createdAt: 0,
        }
      : null;

  const previewObjects = [
    ...(objectsQ.data ?? []),
    ...(draftObject ? [draftObject] : []),
  ];

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
      queryClient.invalidateQueries({ queryKey: ["/api/map-objects"] });
      toast({ title: "Объект удалён" });
    },
    onError: (e: Error) => toast({ title: "Не удалось удалить", description: e.message, variant: "destructive" }),
  });

  const canSave = name.trim().length > 0 && draft.length >= minPoints && !saveM.isPending;

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
            parkings={[]}
            mapObjects={previewObjects}
            height="64vh"
            onMapClick={(coords) => setDraft((d) => [...d, coords])}
          />
          <div className="mt-2 text-xs text-muted-foreground" data-testid="editor-draft-info">
            Точек в черновике: <span className="font-medium text-foreground">{draft.length}</span>
            {draft.length > 0 && draft.length < minPoints && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                нужно минимум {minPoints}
              </span>
            )}
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
                onClick={() => saveM.mutate()}
                disabled={!canSave}
                data-testid="editor-save"
              >
                <Save className="w-4 h-4 mr-2" /> Сохранить
              </Button>
              <Button
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
                    className="flex items-center gap-2 rounded-md border border-card-border px-3 py-2"
                    data-testid={`editor-saved-${o.id}`}
                  >
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: o.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-light truncate">{o.name}</div>
                      <div className="text-[11px] text-muted-foreground">{TYPE_LABEL[o.type] ?? o.type}</div>
                    </div>
                    <Badge variant="secondary" className="text-[10px]">{o.kind === "zone" ? "зона" : "линия"}</Badge>
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
