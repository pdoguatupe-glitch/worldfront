import type { BuildingType, GameUnit, ResourceBundle, TechnologyCategory } from "@worldfront/shared";

export const BUILDINGS: Record<BuildingType, { name: string; cost: { money: number; ore: number }; turns: number; effect: string }> = {
  farm: { name: "Fazenda", cost: { money: 160, ore: 20 }, turns: 1, effect: "+7 alimento/ciclo, +1 estabilidade" },
  mine: { name: "Mina", cost: { money: 220, ore: 35 }, turns: 2, effect: "+6 minério/ciclo" },
  power_plant: { name: "Usina", cost: { money: 280, ore: 45 }, turns: 2, effect: "+8 energia/ciclo" },
  factory: { name: "Fábrica", cost: { money: 420, ore: 65 }, turns: 3, effect: "+5 PIB e +4 produção/ciclo" },
  port: { name: "Porto", cost: { money: 300, ore: 45 }, turns: 2, effect: "desbloqueia unidades navais" },
  railway: { name: "Ferrovia", cost: { money: 250, ore: 40 }, turns: 2, effect: "+15% logística terrestre" },
  base: { name: "Base militar", cost: { money: 350, ore: 60 }, turns: 2, effect: "+10% defesa e recrutamento avançado" },
  research_center: { name: "Centro tecnológico", cost: { money: 400, ore: 50 }, turns: 3, effect: "pesquisa 1 ciclo mais rápida" },
};
export const UNITS: Record<GameUnit, { name: string; cost: { money: number; ore: number; oil: number }; attack: number; defense: number; speed: number; upkeep: number; tech: string | null; }> = {
  infantry: { name: "Infantaria", cost: { money: 40, ore: 3, oil: 0 }, attack: 3, defense: 5, speed: 1, upkeep: 2, tech: null },
  tanks: { name: "Tanques", cost: { money: 120, ore: 16, oil: 3 }, attack: 12, defense: 8, speed: 3, upkeep: 6, tech: "armored_warfare" },
  artillery: { name: "Artilharia", cost: { money: 100, ore: 13, oil: 1 }, attack: 14, defense: 3, speed: 1, upkeep: 5, tech: "modern_artillery" },
  special: { name: "Forças especiais", cost: { money: 180, ore: 8, oil: 3 }, attack: 12, defense: 9, speed: 4, upkeep: 7, tech: "special_operations" },
  fighters: { name: "Caças", cost: { money: 240, ore: 18, oil: 5 }, attack: 16, defense: 10, speed: 8, upkeep: 9, tech: "jet_aircraft" },
  bombers: { name: "Bombardeiros", cost: { money: 300, ore: 22, oil: 7 }, attack: 22, defense: 5, speed: 6, upkeep: 12, tech: "strategic_bombing" },
  drones: { name: "Drones", cost: { money: 180, ore: 9, oil: 2 }, attack: 9, defense: 5, speed: 7, upkeep: 4, tech: "unmanned_systems" },
  ships: { name: "Navios", cost: { money: 350, ore: 28, oil: 8 }, attack: 17, defense: 17, speed: 3, upkeep: 14, tech: "blue_water_navy" },
  submarines: { name: "Submarinos", cost: { money: 390, ore: 30, oil: 7 }, attack: 22, defense: 15, speed: 3, upkeep: 13, tech: "submarine_warfare" },
  carriers: { name: "Porta-aviões", cost: { money: 850, ore: 70, oil: 22 }, attack: 32, defense: 30, speed: 2, upkeep: 32, tech: "carrier_groups" },
  missiles: { name: "Mísseis", cost: { money: 280, ore: 24, oil: 5 }, attack: 30, defense: 1, speed: 5, upkeep: 8, tech: "guided_missiles" },
};
export interface TechSpec { name: string; category: TechnologyCategory; cost: number; turns: number; requires: string[]; effect: string; }
export const TECHNOLOGIES: Record<string, TechSpec> = {
  industrial_methods: { name: "Métodos industriais", category: "industry", cost: 300, turns: 2, requires: [], effect: "+15% renda e produção" },
  agricultural_science: { name: "Agrociência", category: "economy", cost: 240, turns: 2, requires: [], effect: "+25% alimento" },
  energy_grid: { name: "Rede inteligente", category: "energy", cost: 320, turns: 2, requires: [], effect: "+25% energia" },
  logistics: { name: "Logística integrada", category: "military", cost: 350, turns: 2, requires: [], effect: "+15% ataque e defesa" },
  armored_warfare: { name: "Guerra blindada", category: "military", cost: 440, turns: 3, requires: ["logistics"], effect: "desbloqueia tanques; +8% ataque" },
  modern_artillery: { name: "Artilharia moderna", category: "military", cost: 420, turns: 3, requires: ["logistics"], effect: "desbloqueia artilharia" },
  special_operations: { name: "Operações especiais", category: "military", cost: 550, turns: 3, requires: ["logistics"], effect: "desbloqueia forças especiais" },
  jet_aircraft: { name: "Aviação a jato", category: "aviation", cost: 600, turns: 4, requires: ["industrial_methods"], effect: "desbloqueia caças; superioridade aérea" },
  strategic_bombing: { name: "Bombardeio estratégico", category: "aviation", cost: 700, turns: 4, requires: ["jet_aircraft"], effect: "desbloqueia bombardeiros" },
  unmanned_systems: { name: "Sistemas não tripulados", category: "espionage", cost: 520, turns: 3, requires: ["industrial_methods"], effect: "desbloqueia drones; sabotagem" },
  blue_water_navy: { name: "Marinha de alto-mar", category: "navy", cost: 650, turns: 4, requires: ["industrial_methods"], effect: "desbloqueia navios" },
  submarine_warfare: { name: "Guerra submarina", category: "navy", cost: 600, turns: 4, requires: ["blue_water_navy"], effect: "desbloqueia submarinos" },
  carrier_groups: { name: "Grupos aeronaval", category: "navy", cost: 950, turns: 5, requires: ["blue_water_navy", "jet_aircraft"], effect: "desbloqueia porta-aviões" },
  guided_missiles: { name: "Mísseis guiados", category: "military", cost: 780, turns: 4, requires: ["industrial_methods"], effect: "desbloqueia mísseis" },
  counterintelligence: { name: "Contraespionagem", category: "espionage", cost: 400, turns: 2, requires: [], effect: "reduz risco de sabotagem" },
};

export function hasResources(resources: ResourceBundle, cost: Partial<ResourceBundle>): boolean { return Object.entries(cost).every(([key, value]) => (resources[key as keyof ResourceBundle] ?? 0) >= value!); }
export function spend(resources: ResourceBundle, cost: Partial<ResourceBundle>): void { for (const [key, value] of Object.entries(cost)) resources[key as keyof ResourceBundle] -= value!; }
