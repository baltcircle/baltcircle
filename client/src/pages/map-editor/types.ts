export const ADMIN_OBJECTS_KEY = ["/api/admin/map-objects"] as const;

export type ObjType = "route" | "operating" | "slow" | "forbidden";
export type Kind = "route" | "zone";

export interface TypeOption {
  id: ObjType;
  label: string;
  short: string;
  kind: Kind;
  color: string;
  desc: string;
}

export const TYPE_OPTIONS: TypeOption[] = [
  { id: "route",     label: "Маршрут",              short: "Маршрут",   kind: "route", color: "#1d6f8e", desc: "Линия — рекомендованный трек" },
  { id: "operating", label: "Ограничение парковки", short: "Парковка",  kind: "zone",  color: "#1f9e93", desc: "Полигон — только внутри разрешено парковаться" },
  { id: "slow",      label: "Тихая зона (15 км/ч)", short: "Тихая",     kind: "zone",  color: "#c9831f", desc: "Полигон — принудительное ограничение скорости" },
  { id: "forbidden", label: "Запрещённая зона",     short: "Запрет",    kind: "zone",  color: "#d64545", desc: "Полигон — езда запрещена" },
];

export const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.id, o.label]),
);
