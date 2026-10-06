export type RoomMode = "domination" | "economic" | "military" | "score" | "time";
export type RoomStatus = "waiting" | "in_progress" | "finished";
export type GameUnit = "infantry" | "tanks" | "artillery" | "special" | "fighters" | "bombers" | "drones" | "ships" | "submarines" | "carriers" | "missiles";
export type BuildingType = "farm" | "mine" | "power_plant" | "factory" | "port" | "railway" | "base" | "research_center";
export type TechnologyCategory = "military" | "aviation" | "navy" | "economy" | "industry" | "energy" | "espionage";
export interface RoomSettings { maxPlayers: number; mode: RoomMode; private: boolean; password?: string; duration: number; speed: number; fogOfWar: boolean; diplomacy: boolean; aiCount: number; }
export interface RoomPlayer { id: string; name: string; countryId: string | null; ready: boolean; connected: boolean; }
export interface RoomSummary { id: string; name: string; hostId: string; hostName: string; players: number; maxPlayers: number; mode: RoomMode; private: boolean; status: RoomStatus; settings: Omit<RoomSettings, "password">; playerList?: RoomPlayer[]; }
export interface CountryInfo { id: string; code: string; name: string; continent: string; capital: string; population: number; gdp: number; resources: { money: number; oil: number; ore: number; food: number; energy: number }; military: number; technology: number; stability: number; area: number; coordinates: [number,number]; neighbors: string[]; }
export interface CreateRoomRequest { name: string; hostName?: string; settings: RoomSettings; }
export interface ResourceBundle { money: number; oil: number; ore: number; food: number; energy: number; }
export interface Construction { type: BuildingType; turnsLeft: number; }
export interface ResearchProject { id: string; turnsLeft: number; }
export interface NationState { countryId: string; ownerId: string | null; ownerName: string; isAi: boolean; resources: ResourceBundle; population: number; gdp: number; stability: number; morale: number; experience: number; technology: number; units: Record<GameUnit, number>; buildings: Record<BuildingType, number>; construction: Construction[]; technologies: string[]; research: ResearchProject | null; occupation: number; score: number; secretModifiers?: { attack: number; defense: number; production: number; infiniteResources: boolean; infiniteTroops: boolean; instantBuild: boolean; instantResearch: boolean; godMode: boolean; noCooldown: boolean }; }
export interface GameEvent { id: string; turn: number; text: string; type: "event" | "war" | "combat" | "build" | "research" | "diplomacy" | "conquest" | "system"; }
export interface Relation { countryId: string; targetId: string; status: "neutral" | "war" | "alliance" | "peace" | "embargo"; opinion: number; turns: number; }
export interface MovementOrder { id: string; ownerId: string; from: string; to: string; unit: GameUnit; amount: number; turnsLeft: number; }
export interface GameState { id: string; roomId: string; status: "active" | "finished"; mode: RoomMode; turn: number; turnSeconds: number; turnDeadline: number; activePlayerId: string; players: RoomPlayer[]; nations: Record<string, NationState>; movements: MovementOrder[]; relations: Relation[]; offers: { from: string; to: string; type: "alliance" | "peace"; }[]; events: GameEvent[]; winnerId: string | null; winnerName: string | null; updatedAt: number; }
export interface Profile { id: string; name: string; avatar: string; wins: number; losses: number; matches: number; score: number; countriesUsed: string[]; createdAt: number; }
export interface ApiError { error: string; }
