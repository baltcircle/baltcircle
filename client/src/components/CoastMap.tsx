import { useMemo, useRef } from "react";
import type { Bike, Parking, ZoneRow, Ride, MapObject } from "@shared/schema";
import { MAP_W, MAP_H, ROUTES, TOWNS, svgToLatLng, latLngToSvg } from "@shared/geo";

interface Props {
  bikes?: Bike[];
  parkings?: Parking[];
  zones?: ZoneRow[];
  ride?: Ride | null;
  mapObjects?: MapObject[];
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  onMapClick?: (coords: [number, number]) => void;
  height?: number | string;
  showLabels?: boolean;
  interactive?: boolean;
  liveLocation?: { x: number; y: number } | null;
}

function fillFromColor(color: string) {
  return `${color}22`; // ~13% alpha
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
  const overrides: Record<string, { x: number; y: number; anchor: "start" | "end" | "middle" }> = {
    "P-03": { x: -18, y: 2, anchor: "end" },
    "P-05": { x: 0, y: -16, anchor: "middle" },
    "P-09": { x: -18, y: 2, anchor: "end" },
    "P-13": { x: -18, y: 2, anchor: "end" },
    "P-15": { x: 18, y: 18, anchor: "start" },
  };
  return overrides[id] ?? { x: 12, y: 2, anchor: "start" as const };
}

function polyline(points: [number, number][]) {
  return points.map((p, i) => (i === 0 ? "M" : "L") + p[0] + " " + p[1]).join(" ");
}

export function CoastMap({
  bikes = [], parkings = [], zones = [], ride = null, mapObjects = [],
  selectedBikeId, onSelectBike, onMapClick, height = 520, showLabels = true,
  interactive = true, liveLocation = null,
}: Props) {

  const svgRef = useRef<SVGSVGElement | null>(null);

  const parsedZones = useMemo(() => zones.map(z => ({
    ...z, points: JSON.parse(z.polygon) as [number, number][],
  })), [zones]);

  // Operator-drawn objects: convert stored [lat,lng] points to SVG pixels.
  const savedObjects = useMemo(() => {
    return mapObjects.flatMap((o) => {
      let pts: [number, number][];
      try {
        pts = JSON.parse(o.points) as [number, number][];
      } catch {
        return [];
      }
      if (!Array.isArray(pts) || pts.length < 2) return [];
      const px = pts.map(([lat, lng]) => latLngToSvg(lat, lng));
      return [{ id: o.id, kind: o.kind, color: o.color, px }];
    });
  }, [mapObjects]);

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!onMapClick) return;
    const svg = svgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    onMapClick(svgToLatLng(local.x, local.y));
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-card-border bg-card" style={{ height }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid slice"
        data-testid="map-svg"
        onClick={onMapClick ? handleClick : undefined}
        style={onMapClick ? { cursor: "crosshair" } : undefined}
      >
        <defs>
          <linearGradient id="seaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="hsl(var(--brand-sea))" stopOpacity="0.45" />
            <stop offset="100%" stopColor="hsl(var(--brand-sea-soft))" />
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

        {/* Baltic Sea — runs along the top, with a gently curved shoreline */}
        <path
          d="M0 0 H1000 V150
             C 900 175, 800 200, 700 195
             C 600 190, 540 165, 470 175
             C 380 188, 300 235, 215 235
             C 140 235, 70 205, 0 200 Z"
          fill="url(#seaGradient)"
          data-testid="map-sea"
        />
        {/* foamy shoreline accent */}
        <path
          d="M0 200 C 70 205, 140 235, 215 235
             C 300 235, 380 188, 470 175
             C 540 165, 600 190, 700 195
             C 800 200, 900 175, 1000 150"
          fill="none"
          stroke="hsl(var(--brand-foam))"
          strokeWidth="3"
          opacity="0.8"
        />

        {/* Curonian Spit (Куршская коса) — sandy peninsula to the east */}
        <path
          d="M905 360 C 935 300, 950 240, 940 180 C 936 160, 922 150, 916 168 C 924 240, 905 300, 890 350 Z"
          fill="hsl(var(--brand-sand-soft))"
          stroke="hsl(var(--brand-sand-deep) / 0.5)"
          opacity="0.9"
        />

        {/* green belts / coastal pine forest near towns */}
        <ellipse cx="215" cy="430" rx="80" ry="34" fill="hsl(174 40% 70% / 0.30)" />
        <ellipse cx="470" cy="440" rx="70" ry="30" fill="hsl(174 40% 70% / 0.30)" />
        <ellipse cx="800" cy="450" rx="80" ry="34" fill="hsl(174 40% 70% / 0.30)" />

        {/* Coastal road lattice (light reference grid) */}
        <g stroke="hsl(var(--brand-sand-deep) / 0.40)" strokeWidth="1.2" fill="none">
          <path d="M120 400 C 360 470, 640 470, 950 400" />
          <path d="M150 320 L 220 480" />
          <path d="M500 280 L 500 470" />
          <path d="M820 300 L 850 470" />
        </g>

        {/* Cycling routes (велодорожки) — drawn under markers, above base map */}
        <g data-testid="routes">
          {ROUTES.map((r) => {
            const d = polyline(r.points);
            const mid = r.points[Math.floor(r.points.length / 2)];
            return (
              <g key={r.id} data-testid={`route-${r.id}`}>
                {/* casing */}
                <path d={d} fill="none" stroke="hsl(var(--brand-foam))" strokeWidth="8"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
                {/* route line */}
                <path d={d} fill="none" stroke="hsl(174 64% 38%)" strokeWidth="4"
                  strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 9" />
                <path d={d} fill="none" stroke="hsl(174 64% 38%)" strokeWidth="4"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
                {showLabels && (
                  <g transform={`translate(${mid[0]} ${mid[1] - 12})`}>
                    <text fontSize="10" textAnchor="middle" stroke="hsl(var(--brand-foam))"
                      strokeWidth="3" strokeLinejoin="round" className="font-semibold">
                      {r.name} · {r.distanceKm} км
                    </text>
                    <text fontSize="10" textAnchor="middle" fill="hsl(174 64% 26%)" className="font-semibold">
                      {r.name} · {r.distanceKm} км
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {/* Town anchors + names */}
        <g data-testid="towns">
          {TOWNS.map(t => (
            <g key={t.id} transform={`translate(${t.x} ${t.y})`} data-testid={`town-${t.id}`}>
              <circle r="6" fill="hsl(var(--brand-sea))" stroke="hsl(var(--brand-foam))" strokeWidth="2" />
              <text x="0" y="-12" fontSize="14" textAnchor="middle"
                stroke="hsl(var(--brand-foam))" strokeWidth="3.5" strokeLinejoin="round"
                className="font-display font-semibold">
                {t.name}
              </text>
              <text x="0" y="-12" fontSize="14" textAnchor="middle"
                fill="hsl(var(--brand-bark))" className="font-display font-semibold">
                {t.name}
              </text>
            </g>
          ))}
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

        {/* Operator-drawn routes & zones (incl. live editor draft) */}
        <g data-testid="map-objects">
          {savedObjects.map((o) => {
            if (o.kind === "zone") {
              const d = o.px.map((p, i) => (i === 0 ? "M" : "L") + p[0] + " " + p[1]).join(" ") + " Z";
              return (
                <path key={o.id} d={d} fill={fillFromColor(o.color)} stroke={o.color}
                  strokeWidth="2" strokeLinejoin="round" data-testid={`map-object-${o.id}`} />
              );
            }
            const d = o.px.map((p, i) => (i === 0 ? "M" : "L") + p[0] + " " + p[1]).join(" ");
            return (
              <path key={o.id} d={d} fill="none" stroke={o.color} strokeWidth="5"
                strokeLinecap="round" strokeLinejoin="round" opacity="0.95"
                data-testid={`map-object-${o.id}`} />
            );
          })}
        </g>
      </svg>
    </div>
  );
}
