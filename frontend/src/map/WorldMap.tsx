import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { geoEqualEarth, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology } from "topojson-specification";
import type { CountryInfo, GameState } from "@worldfront/shared";
import topology from "world-atlas/countries-110m.json";

interface Props { countries: CountryInfo[]; game: GameState | null; viewerId: string; selected: string | null; onSelect: (id: string) => void; mode: "political" | "economic" | "military" | "diplomacy"; }
const colors = ["#617b50", "#4f7680", "#947046", "#75648e", "#548573", "#9a6356", "#557094", "#89944f", "#5c8e8d", "#895c81"];
const ownerColor = (id: string) => { let n = 0; for (const c of id) n = (n * 31 + c.charCodeAt(0)) | 0; return colors[Math.abs(n) % colors.length]!; };
const typedTopology = topology as unknown as Topology;
const geometries = (feature(typedTopology, typedTopology.objects.countries as never) as unknown as FeatureCollection<Geometry>).features as (Feature<Geometry> & { id?: string | number })[];

export default function WorldMap({ countries, game, viewerId, selected, onSelect, mode }: Props) {
  const [zoom, setZoom] = useState(1); const [pan, setPan] = useState({ x: 0, y: 0 }); const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null); const suppressClick = useRef(false);
  const catalog = useMemo(() => new Map(countries.map(c => [String(Number(c.id)), c])), [countries]);
  const projection = useMemo(() => geoEqualEarth().fitSize([1040, 520], { type: "Sphere" }), []);
  const path = useMemo(() => geoPath(projection), [projection]);
  const down = (event: PointerEvent<SVGSVGElement>) => { drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); };
  const move = (event: PointerEvent<SVGSVGElement>) => { if (!drag.current) return; const dx = event.clientX - drag.current.x; const dy = event.clientY - drag.current.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true; if (drag.current.moved) setPan({ x: drag.current.px + dx, y: drag.current.py + dy }); };
  const end = () => { suppressClick.current = Boolean(drag.current?.moved); drag.current = null; };
  const wheel = (event: WheelEvent<SVGSVGElement>) => { event.preventDefault(); setZoom(z => Math.max(1, Math.min(5, z * (event.deltaY < 0 ? 1.16 : .86)))); };
  return <div className="map-wrap"><div className="map-tools"><button onClick={() => setZoom(z => Math.min(5, z * 1.3))} aria-label="Ampliar mapa">+</button><button onClick={() => setZoom(z => Math.max(1, z / 1.3))} aria-label="Reduzir mapa">−</button><button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Redefinir mapa">⌖</button></div>
    <svg className="world-map" viewBox="0 0 1040 520" role="img" aria-label="Mapa mundial interativo" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onWheel={wheel}>
      <defs><radialGradient id="ocean" cx="48%" cy="47%" r="68%"><stop stopColor="#12232c"/><stop offset="1" stopColor="#0a141d"/></radialGradient><pattern id="grid" width="52" height="52" patternUnits="userSpaceOnUse"><path d="M52 0H0V52" fill="none" stroke="#8ca7a0" strokeOpacity=".065" strokeWidth=".7"/></pattern><marker id="movement-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#e4d27d"/></marker></defs>
      <rect width="1040" height="520" fill="url(#ocean)"/><rect width="1040" height="520" fill="url(#grid)"/>
      <g transform={`translate(${pan.x + 520 * (1 - zoom)} ${pan.y + 260 * (1 - zoom)}) scale(${zoom})`}>
        {geometries.map((shape, index) => {
          const id = String(Number(shape.id ?? "0")).padStart(3, "0"); const country = catalog.get(String(Number(id))); if (!country) return null;
          const nation = game?.nations[country.id]; const own = nation?.ownerId === viewerId; let fill = "#243640";
          if (nation?.ownerId) fill = ownerColor(nation.ownerId);
          if (mode === "economic" && nation) fill = `hsl(${Math.min(135, 102 + nation.gdp / 180)} 43% ${Math.max(26, Math.min(55, 30 + Math.log10(nation.gdp + 1) * 6))}%)`;
          if (mode === "military" && nation) fill = `hsl(${Math.max(5, 118 - Math.min(110, Object.values(nation.units).reduce((a,b)=>a+b,0) * 1.4))} 56% 39%)`;
          if (mode === "diplomacy" && nation) { const statuses = game?.relations.filter(r => r.countryId === nation.countryId || r.targetId === nation.countryId) ?? []; fill = statuses.some(r=>r.status==="war") ? "#a44942" : statuses.some(r=>r.status==="alliance") ? "#54836c" : fill; }
          const isSelected = selected === country.id;
          return <path key={`${country.id}-${index}`} d={path(shape as Feature<Geometry>) ?? undefined} fill={fill} fillOpacity={nation?.ownerId ? .88 : .74} stroke={isSelected ? "#d1ed9b" : own ? "#e0f4ae" : "#91a9a4"} strokeWidth={(isSelected ? 1.45 : .55) / zoom} strokeOpacity={isSelected || own ? .95 : .55} className="map-country" onClick={(e) => { e.stopPropagation(); if (!suppressClick.current) onSelect(country.id); suppressClick.current = false; }} onPointerEnter={e => setHover({ id: country.id, x: e.clientX, y: e.clientY })} onPointerLeave={() => setHover(null)}><title>{country.name}{nation?.ownerId ? ` · ${nation.ownerName}` : ""}</title></path>;
        })}
        {(game?.movements??[]).map(order=>{const from=catalog.get(String(Number(order.from)));const to=catalog.get(String(Number(order.to)));if(!from||!to)return null;const a=projection(from.coordinates);const b=projection(to.coordinates);if(!a||!b)return null;return <g key={order.id} className="troop-movement"><path d={`M${a[0]},${a[1]} Q${(a[0]+b[0])/2+9},${(a[1]+b[1])/2-10} ${b[0]},${b[1]}`} fill="none" stroke="#e4d27d" strokeWidth={1.6/zoom} strokeDasharray={`${4/zoom} ${3/zoom}`} markerEnd="url(#movement-arrow)"/><circle cx={a[0]} cy={a[1]} r={4/zoom} fill="#f0d482"><title>{order.amount} {order.unit} · {order.turnsLeft} ciclos</title></circle></g>;})}
      </g>
    </svg>
    <div className="map-coordinates"><span>WORLD THEATER / 01</span><span>PROJECTION · EQUAL EARTH</span></div>
    {hover && (() => { const country = countries.find(c => c.id === hover.id); const nation = game?.nations[hover.id]; if (!country) return null; return <div className="map-tooltip" style={{ left: Math.min(hover.x + 12, window.innerWidth - 210), top: Math.max(hover.y - 53, 12) }}><b>{country.name}</b><span>{nation?.ownerId ? `Controlado por ${nation.ownerName}` : country.continent}</span><small>{nation?.ownerId ? `${nation.population.toFixed(1)}M habitantes · ${nation.gdp} PIB` : `População ${country.population.toFixed(1)}M · ${country.continent}`}</small></div>; })()}
  </div>;
}
