import { useMemo } from "react";
import type { Bike, Parking, ZoneRow, Ride } from "@shared/schema";
import { MAP_W, MAP_H } from "@shared/geo";

interface Props {
  bikes?: Bike[];
  parkings?: Parking[];
  zones?: ZoneRow[];
  ride?: Ride | null;
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  height?: number | string;
  showLabels?: boolean;
  interactive?: boolean;
  liveLocation?: { x: number; y: number } | null;
}

function zoneFill(kind: string) {
  if (kind === "forbidden") return "hsl(0 70% 55% / 0.16)";
  if (kind === "slow")      return "hsl(36 80% 60% / 0.20)";
  if (kind === "operating") return "hsl(var(--brand-sea) / 0.06)";
  return "transparent";
}
function zoneStroke(kind: string) {
  if (kind === "forbidden") return "hsl(0 70% 55%)";
  if (kind === "slow")      return "hsl(36 80% 50%)";
  if (kind === "operating") return "hsl(var(--brand-sea))";
  return "currentColor";
}

function zoneLabel(zone: ZoneRow) {
  if (zone.kind === "slow") return "15 км/ч";
  if (zone.kind === "forbidden") return "Запрет";
  return zone.name;
}

function parkingLabelProps(id: string) {
  const overrides: Record<string, { x: number; y: number; anchor?: "start" | "end" }> = {
    "P-01": { x: -18, y: -16, anchor: "end" },
    "P-02": { x: 18, y: -18, anchor: "start" },
    "P-06": { x: 18, y: -14, anchor: "start" },
    "P-07": { x: 18, y: 21, anchor: "start" },
    "P-08": { x: 20, y: 17, anchor: "start" },
    "P-13": { x: 20, y: -13, anchor: "start" },
    "P-15": { x: -18, y: 19, anchor: "end" },
  };
  return overrides[id] ?? { x: 12, y: 2, anchor: "start" as const };
}

export function KaliningradMap({
  bikes = [], parkings = [], zones = [], ride = null,
  selectedBikeId, onSelectBike, height = 520, showLabels = true,
  interactive = true, liveLocation = null,
}: Props) {

  const parsedZones = useMemo(() => zones.map(z => ({
    ...z, points: JSON.parse(z.polygon) as [number, number][],
  })), [zones]);

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-card-border bg-card" style={{ height }}>
      <svg
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid slice"
        data-testid="map-svg"
      >
        <defs>
          <linearGradient id="seaGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"  stopColor="hsl(var(--brand-sea-soft))" />
            <stop offset="100%" stopColor="hsl(var(--brand-sea) / 0.30)" />
          </linearGradient>
          <linearGradient id="landGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="hsl(var(--brand-sand-soft))" />
            <stop offset="100%" stopColor="hsl(var(--brand-sand) / 0.55)" />
          </linearGradient>
          <pattern id="forbiddenStripes" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="hsl(0 70% 55%)" strokeWidth="2" opacity="0.45" />
          </pattern>
          <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="1" floodOpacity="0.18" />
          </filter>
        </defs>

        {/* base land */}
        <rect width={MAP_W} height={MAP_H} fill="url(#landGradient)" />

        {/* Baltic bay — west water */}
        <path
          d="M0 0 L150 0 C 130 100, 110 220, 140 320 C 165 410, 130 520, 80 600 L 0 640 Z"
          fill="url(#seaGradient)"
        />
        {/* Pregolya river ribbon */}
        <path
          d="M0 430 C 200 460, 360 380, 450 430 C 540 480, 620 440, 760 470 C 880 495, 950 470, 1000 480 L 1000 510 C 950 500, 880 525, 760 500 C 620 470, 540 510, 450 460 C 360 410, 200 490, 0 460 Z"
          fill="hsl(var(--brand-sea-soft))"
          opacity="0.9"
        />
        {/* Island of Kant - middle */}
        <ellipse cx="460" cy="465" rx="55" ry="20" fill="hsl(var(--brand-sand-soft))" stroke="hsl(var(--brand-sand-deep) / 0.6)" />
        {/* parks */}
        <ellipse cx="665" cy="220" rx="55" ry="34" fill="hsl(174 40% 70% / 0.45)" />
        <ellipse cx="320" cy="200" rx="45" ry="28" fill="hsl(174 40% 70% / 0.35)" />
        <ellipse cx="830" cy="380" rx="42" ry="26" fill="hsl(174 40% 70% / 0.35)" />

        {/* Road lattice */}
        <g stroke="hsl(var(--brand-sand-deep) / 0.45)" strokeWidth="1.2" fill="none">
          <path d="M 180 130 L 220 550" />
          <path d="M 340 110 L 360 620" />
          <path d="M 520 110 L 500 640" />
          <path d="M 720 130 L 700 620" />
          <path d="M 860 200 L 820 560" />
          <path d="M 140 280 L 900 320" />
          <path d="M 150 420 L 890 450" />
          <path d="M 220 550 L 820 560" />
          <path d="M 180 180 L 860 200" />
        </g>

        {/* Zones */}
        {parsedZones.map(z => {
          const d = z.points.map((p, i) => (i === 0 ? "M" : "L") + p[0] + " " + p[1]).join(" ") + " Z";
          return (
            <g key={z.id}>
              <path
                d={d}
                fill={z.kind === "forbidden" ? "url(#forbiddenStripes)" : zoneFill(z.kind)}
                stroke={zoneStroke(z.kind)}
                strokeWidth={z.kind === "operating" ? 1.6 : 1.2}
                strokeDasharray={z.kind === "forbidden" ? "0" : z.kind === "slow" ? "5 4" : "0"}
                opacity={z.kind === "operating" ? 0.7 : 1}
              />
              {showLabels && z.kind !== "operating" && (
                <text
                  x={(Math.min(...z.points.map(p => p[0])) + Math.max(...z.points.map(p => p[0]))) / 2}
                  y={(Math.min(...z.points.map(p => p[1])) + Math.max(...z.points.map(p => p[1]))) / 2 + 4}
                  fontSize="9"
                  textAnchor="middle"
                  fill={z.kind === "forbidden" ? "hsl(0 70% 35%)" : "hsl(36 70% 30%)"}
                  className="font-semibold"
                >
                  {zoneLabel(z)}
                </text>
              )}
            </g>
          );
        })}

        {/* Parkings */}
        {parkings.map(p => {
          const label = parkingLabelProps(p.id);
          return (
            <g key={p.id} transform={`translate(${p.lng} ${p.lat})`} data-testid={`parking-${p.id}`}>
              <rect x="-9" y="-9" width="18" height="18" rx="4"
                fill="hsl(var(--brand-foam))"
                stroke="hsl(var(--brand-sea))"
                strokeWidth="1.6"
                filter="url(#softShadow)"
              />
              <text x="0" y="3" fontSize="9" textAnchor="middle" fontWeight="700" fill="hsl(var(--brand-sea))">P</text>
              {showLabels && (
                <>
                  <text x={label.x} y={label.y} fontSize="9.5" textAnchor={label.anchor} stroke="hsl(var(--brand-foam))" strokeWidth="3" strokeLinejoin="round" className="font-medium">
                    {p.name}
                  </text>
                  <text x={label.x} y={label.y} fontSize="9.5" textAnchor={label.anchor} fill="hsl(var(--brand-bark))" className="font-medium">
                    {p.name}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* Bikes */}
        {bikes.map(b => {
          const isSel = b.id === selectedBikeId;
          const color = b.status === "available"   ? "hsl(174 60% 38%)"
                       : b.status === "rented"     ? "hsl(var(--brand-sea))"
                       : b.status === "maintenance"? "hsl(0 70% 55%)"
                       : b.status === "reserved"   ? "hsl(36 80% 50%)"
                       :                              "hsl(220 8% 55%)";
          return (
            <g key={b.id}
               transform={`translate(${b.lng} ${b.lat})`}
               onClick={() => onSelectBike?.(b.id)}
               style={{ cursor: interactive ? "pointer" : "default" }}
               data-testid={`bike-marker-${b.id}`}
            >
              {isSel && <circle r="14" fill="hsl(var(--brand-sea) / 0.16)" className="map-pulse" />}
              <circle r={isSel ? 6 : 4.5} fill={color} stroke="hsl(var(--brand-foam))" strokeWidth="1.4" />
            </g>
          );
        })}

        {/* Active ride track */}
        {ride && (() => {
          try {
            const pts = JSON.parse(ride.track) as [number, number, number][];
            const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0] + " " + p[1]).join(" ");
            const last = pts[pts.length - 1];
            return (
              <g data-testid="ride-track">
                <path d={d} fill="none" stroke="hsl(var(--brand-sea))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
                <circle cx={pts[0][0]} cy={pts[0][1]} r="5" fill="hsl(var(--brand-sea))" stroke="hsl(var(--brand-foam))" strokeWidth="1.6" />
                <circle cx={last[0]} cy={last[1]} r="7" fill="hsl(36 92% 55%)" stroke="hsl(var(--brand-foam))" strokeWidth="2">
                  <animate attributeName="r" values="7;10;7" dur="1.4s" repeatCount="indefinite" />
                </circle>
              </g>
            );
          } catch { return null; }
        })()}

        {/* Live location pin (not in ride) */}
        {liveLocation && !ride && (
          <g data-testid="live-location">
            <circle cx={liveLocation.x} cy={liveLocation.y} r="14" fill="hsl(var(--brand-sea) / 0.14)" className="map-pulse" />
            <circle cx={liveLocation.x} cy={liveLocation.y} r="5" fill="hsl(var(--brand-sea))" stroke="hsl(var(--brand-foam))" strokeWidth="1.8" />
          </g>
        )}
      </svg>
    </div>
  );
}
