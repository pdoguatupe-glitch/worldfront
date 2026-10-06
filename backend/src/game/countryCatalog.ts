import { createRequire } from "node:module";
import { neighbors } from "topojson-client";
import type { CountryInfo } from "@worldfront/shared";
import type { Country } from "world-countries";

const require = createRequire(import.meta.url);
const countries = require("world-countries") as Country[];
const populationRows = require("country-json/src/country-by-population.json") as { country: string; population: number }[];
const populationByName = new Map(populationRows.map(row => [row.country, row.population / 1_000_000]));
const countryNames = require("i18n-iso-countries") as { registerLocale: (locale: object) => void; getName: (code: string, locale: string) => string | undefined };
countryNames.registerLocale(require("i18n-iso-countries/langs/pt.json") as object);
interface Geometry { id?: string | number; }
interface CountriesTopology { objects: { countries: { geometries: Geometry[] } }; }
const topology = require("world-atlas/countries-110m.json") as CountriesTopology;
const geoms = topology.objects.countries.geometries;
const adjacency = neighbors(geoms as never) as number[][];
const byNumeric = new Map(countries.filter(c => c.ccn3 !== "").map(c => [String(Number(c.ccn3)), c]));

const populationMillions: Record<string, number> = {
  CHN: 1410, IND: 1430, USA: 334, IDN: 278, PAK: 241, NGA: 224, BRA: 203, BGD: 173,
  RUS: 144, MEX: 129, JPN: 124, ETH: 126, PHL: 117, EGY: 112, COD: 102, VNM: 100,
  IRN: 89, TUR: 85, DEU: 84, THA: 71, GBR: 68, FRA: 68, ZAF: 62, ITA: 59, KOR: 52,
  COL: 52, ESP: 48, ARG: 46, UKR: 37, CAN: 40, POL: 38, MAR: 37, SAU: 36, PER: 34,
  AFG: 42, IRQ: 45, VEN: 29, AUS: 27, NPL: 30, MYS: 34, GHA: 34, TWN: 23, SYR: 23,
  NER: 27, MOZ: 34, MLI: 23, BFA: 23, LKA: 22, CHL: 20, KAZ: 20, ROU: 19, NLD: 18,
  ECU: 18, GTM: 18, SEN: 18, KHM: 17, ZMB: 20, TCD: 18, SOM: 18, ZWE: 16, GIN: 14,
  BEN: 14, RWA: 14, BDI: 13, TUN: 12, BOL: 12, BEL: 12, CUB: 11, HTI: 12, SSD: 11,
  DOM: 11, CZE: 11, GRC: 10, SWE: 11, PRT: 10, AZE: 10, ISR: 10, HUN: 10, ARE: 10,
};
const strategic = new Set(["USA", "CHN", "RUS", "IND", "DEU", "FRA", "GBR", "JPN", "KOR", "BRA", "TUR", "IRN", "SAU", "ISR", "UKR", "CAN", "AUS", "ITA", "PAK", "IDN"]);

export const countryCatalog: CountryInfo[] = geoms.flatMap((geometry, index) => {
  if (geometry.id == null) return [];
  const id = String(geometry.id).padStart(3, "0");
  const country = byNumeric.get(String(Number(id)));
  if (!country || country.name.common === "Antarctica" || country.region === "Antarctic") return [];
  const pop = populationByName.get(country.name.common) ?? populationMillions[country.cca3] ?? Math.max(0.05, Math.round((Math.sqrt(country.area || 30000) * ((Number(id) % 9) + 1) / 23)) / 10);
  const richness = Math.max(0.65, Math.min(1.8, 0.8 + ((Number(id) * 17) % 91) / 100));
  const power = strategic.has(country.cca3) ? 1.7 : 0.75 + ((Number(id) * 13) % 50) / 100;
  const continent = ({ Africa: "África", Americas: "Américas", Asia: "Ásia", Europe: "Europa", Oceania: "Oceania" } as Record<string,string>)[country.region] ?? country.region ?? "Outro";
  return [{
    id, code: country.cca3, name: countryNames.getName(country.cca2, "pt") ?? country.name.common, continent,
    capital: country.capital?.[0] ?? "—", population: pop, area: country.area || 0,
    coordinates: [(country.latlng?.[1] ?? 0), (country.latlng?.[0] ?? 0)],
    gdp: Math.round(pop * (2 + richness * 6)), military: Math.round(Math.sqrt(pop) * 19 * power),
    technology: Math.round((strategic.has(country.cca3) ? 5 : 2) + (Number(id) % 4)), stability: 62 + (Number(id) * 7) % 31,
    resources: { money: Math.round(250 + pop * 22 * richness), oil: Math.round(18 + pop * (country.landlocked ? 0.035 : 0.08) * richness), ore: Math.round(25 + pop * 0.11 * richness), food: Math.round(20 + pop * (country.area > 500000 ? 0.2 : 0.11)), energy: Math.round(25 + pop * 0.13 * richness) },
    neighbors: (adjacency[index] ?? []).flatMap(neighborIndex => { const neighbor = geoms[neighborIndex]; return neighbor?.id == null ? [] : [String(neighbor.id).padStart(3, "0")]; }),
  }];
});

// Natural Earth can leave narrow borders asymmetric at this resolution; game movement and attacks
// need one shared, symmetric definition regardless of which country initiated the action.
for (const country of countryCatalog) {
  const reverseNeighbors = countryCatalog.filter(other => other.neighbors.includes(country.id)).map(other => other.id);
  country.neighbors = [...new Set([...country.neighbors, ...reverseNeighbors])];
}

export const countryById = new Map(countryCatalog.map(country => [country.id, country]));
