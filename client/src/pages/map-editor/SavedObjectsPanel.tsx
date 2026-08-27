import type { MapObject } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Map as MapIcon,
  Trash2,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronLeft,
  Pencil,
} from "lucide-react";
import { TYPE_LABEL, type Kind } from "./types";

export function SavedObjectsPanel({
  objects, panelOpen, setPanelOpen,
  onEdit, onToggle, disableToggle, onDelete, disableDelete,
}: {
  objects: MapObject[] | undefined;
  panelOpen: boolean;
  setPanelOpen: (updater: (v: boolean) => boolean) => void;
  onEdit: (o: MapObject) => void;
  onToggle: (o: MapObject) => void;
  disableToggle: boolean;
  onDelete: (o: MapObject) => void;
  disableDelete: boolean;
}) {
  return (
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
            {objects?.length ?? 0}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto space-y-2 -mx-1 px-1">
          {(objects?.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="editor-saved-empty">
              Пока нет объектов. Карта в приложении пустая.
            </div>
          ) : (
            objects!.map((o) => (
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
                  onClick={() => onEdit(o)}
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
                  onClick={() => onToggle(o)}
                  disabled={disableToggle}
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
                    if (window.confirm(`Удалить «${o.name}»?`)) onDelete(o);
                  }}
                  disabled={disableDelete}
                  data-testid={`editor-delete-${o.id}`}
                  aria-label="Удалить объект"
                >
                  <Trash2 className="w-3.5 h-3.5 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>
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
  );
}
