import { Check, CircleDot, Info } from "lucide-react";
import type { Kind } from "./types";

export function DraftInfo({ draft, minPoints, kind }: { draft: [number, number][]; minPoints: number; kind: Kind }) {
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

export function HintBlock({ kind }: { kind: Kind }) {
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
