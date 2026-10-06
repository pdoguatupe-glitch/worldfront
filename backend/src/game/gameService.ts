import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { BuildingType, CountryInfo, GameEvent, GameState, GameUnit, Profile, Relation, RoomPlayer, RoomSettings, RoomSummary } from "@worldfront/shared";
import { countryById, countryCatalog } from "./countryCatalog.js";
import { BUILDINGS, TECHNOLOGIES, UNITS, hasResources, spend } from "./rules.js";

interface ChatMessage { id: string; playerId: string; playerName: string; text: string; time: number; }
interface RoomData { id: string; name: string; hostId: string; status: "waiting" | "in_progress" | "finished"; settings: RoomSettings; passwordHash: string | null; players: RoomPlayer[]; game: GameState | null; goalCountries: string[]; chat: ChatMessage[]; aiDifficulty: "easy" | "normal" | "hard"; }
interface PersistedData { profiles: Record<string, Profile>; sessions: Record<string, string>; rooms: Record<string, RoomData>; }
interface NewPlayer { profile: Profile; sessionToken: string; }
type Action =
  | { type: "build"; building: BuildingType; countryId?: string }
  | { type: "recruit"; unit: GameUnit; amount: number; countryId?: string }
  | { type: "research"; technology: string; countryId?: string }
  | { type: "declare_war"; targetCountry: string; countryId?: string }
  | { type: "attack"; fromCountry: string; targetCountry: string }
  | { type: "move"; fromCountry: string; targetCountry: string; unit: GameUnit; amount: number }
  | { type: "offer"; targetPlayerId: string; treaty: "alliance" | "peace" }
  | { type: "respond_offer"; offerIndex: number; accept: boolean }
  | { type: "trade"; targetPlayerId: string; give: "money" | "oil" | "ore" | "food" | "energy"; giveAmount: number; receive: "money" | "oil" | "ore" | "food" | "energy"; receiveAmount: number }
  | { type: "sabotage"; targetCountry: string }
  | { type: "black_ops"; countryId: string; changes: { money?: number; population?: number; military?: number; production?: number; technology?: number; moral?: number; resources?: Partial<Record<"oil" | "ore" | "food" | "energy", number>>; infiniteResources?: boolean; infiniteTroops?: boolean; instantBuild?: boolean; instantResearch?: boolean; noCooldown?: boolean; godMode?: boolean; attack?: number; defense?: number; } }
  | { type: "end_turn" };
const AI_NAMES = ["Aegis", "Orion", "Meridian", "Vanguard", "Helios", "Sentinel", "Atlas", "Nexus", "Bastion", "Argus"];
const UNIT_KEYS: GameUnit[] = ["infantry", "tanks", "artillery", "special", "fighters", "bombers", "drones", "ships", "submarines", "carriers", "missiles"];
const BUILDING_KEYS: BuildingType[] = ["farm", "mine", "power_plant", "factory", "port", "railway", "base", "research_center"];
const RESOURCE_KEYS = ["money", "oil", "ore", "food", "energy"] as const;
const DEFAULT_SETTINGS: RoomSettings = { maxPlayers: 6, mode: "domination", private: false, duration: 30, speed: 1, fogOfWar: true, diplomacy: true, aiCount: 3 };
const filePath = resolve(process.env.DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../data"), "worldfront.json");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeName = (value: string) => value.replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 24);
const initialData = (): PersistedData => ({ profiles: {}, sessions: {}, rooms: {} });

export class GameService {
  private data: PersistedData;
  private readonly storagePath: string;
  private pool: Pool | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceError: Error | null = null;
  readonly ready: Promise<void>;
  constructor(storagePath = filePath) {
    this.storagePath = storagePath;
    try {
      this.data = existsSync(this.storagePath) ? { ...initialData(), ...JSON.parse(readFileSync(this.storagePath, "utf8")) as Partial<PersistedData> } : initialData();
      for (const room of Object.values(this.data.rooms)) { for (const player of room.players) player.connected = false; if (room.game) { room.game.movements ??= []; room.game.offers ??= []; for (const player of room.game.players) player.connected = false; } }
    }
    catch { this.data = initialData(); }
    const databaseUrl = process.env.DATABASE_URL;
    if (process.env.NODE_ENV === "production" && !databaseUrl) throw new Error("DATABASE_URL é obrigatório em produção para persistir perfis e partidas.");
    if (databaseUrl) {
      this.pool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
      this.ready = this.loadDatabase();
    } else this.ready = Promise.resolve();
  }

  private save(): void {
    if (this.pool) {
      const snapshot = JSON.stringify(this.data);
      this.persistenceQueue = this.persistenceQueue.then(async () => {
        await this.pool!.query("INSERT INTO worldfront_state (id, data, updated_at) VALUES ('worldfront', $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at", [snapshot]);
        this.persistenceError = null;
      }).catch(error => { this.persistenceError = error instanceof Error ? error : new Error("Falha ao salvar no PostgreSQL."); console.error("WorldFront PostgreSQL persistence failed:", this.persistenceError.message); });
      return;
    }
    mkdirSync(dirname(this.storagePath), { recursive: true });
    const temp = `${this.storagePath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data)); renameSync(temp, this.storagePath);
  }
  private async loadDatabase(): Promise<void> {
    const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations/001_initial.sql");
    await this.pool!.query(readFileSync(migrationPath, "utf8"));
    const result = await this.pool!.query<{ data: PersistedData }>("SELECT data FROM worldfront_state WHERE id = 'worldfront'");
    if (result.rows[0]) this.data = result.rows[0].data;
    else { this.data = initialData(); await this.pool!.query("INSERT INTO worldfront_state (id, data) VALUES ('worldfront', $1::jsonb)", [JSON.stringify(this.data)]); }
    for (const room of Object.values(this.data.rooms)) { for (const player of room.players) player.connected = false; if (room.game) { room.game.movements ??= []; room.game.offers ??= []; for (const player of room.game.players) player.connected = false; } }
  }
  async flush(): Promise<void> { await this.persistenceQueue; if (this.persistenceError) throw new Error("Não foi possível persistir o estado da partida. Tente novamente."); }
  async close(): Promise<void> { await this.flush(); await this.pool?.end(); }
  get storageType(): "postgres" | "json-file" { return this.pool ? "postgres" : "json-file"; }
  private profile(id: string): Profile { const profile = this.data.profiles[id]; if (!profile) throw new Error("Perfil não encontrado."); return profile; }
  private room(id: string): RoomData { const room = this.data.rooms[id.toUpperCase()]; if (!room) throw new Error("Sala não encontrada."); return room; }
  private accountByToken(token: string | undefined): Profile | null { if (!token) return null; const playerId = this.data.sessions[hash(token)]; return playerId ? this.data.profiles[playerId] ?? null : null; }
  authenticate(token: string | undefined): Profile { const result = this.accountByToken(token); if (!result) throw new Error("Sessão inválida. Recarregue a página e entre novamente."); return result; }

  createProfile(name: string): NewPlayer {
    const clean = safeName(name);
    if (clean.length < 2) throw new Error("O nome precisa ter pelo menos 2 caracteres.");
    const id = randomUUID(); const sessionToken = randomBytes(32).toString("base64url");
    const profile: Profile = { id, name: clean, avatar: clean.slice(0, 1).toUpperCase(), wins: 0, losses: 0, matches: 0, score: 0, countriesUsed: [], createdAt: Date.now() };
    this.data.profiles[id] = profile; this.data.sessions[hash(sessionToken)] = id; this.save(); return { profile, sessionToken };
  }
  updateProfile(profile: Profile, name: string): Profile { profile.name = safeName(name); if (profile.name.length < 2) throw new Error("O nome precisa ter pelo menos 2 caracteres."); profile.avatar = profile.name[0]!.toUpperCase(); for (const room of Object.values(this.data.rooms)) { const player = room.players.find(p => p.id === profile.id); if (player) player.name = profile.name; if (room.game) { const gp = room.game.players.find(p => p.id === profile.id); if (gp) gp.name = profile.name; } } this.save(); return profile; }
  ranking(): Profile[] { return Object.values(this.data.profiles).sort((a, b) => b.score - a.score || b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, 100); }
  countries(): CountryInfo[] { return countryCatalog; }
  profileById(id: string): Profile | null { return this.data.profiles[id] ?? null; }

  private publicRoom(room: RoomData, includePlayers = true): RoomSummary {
    const { password: _password, ...settings } = room.settings;
    return { id: room.id, name: room.name, hostId: room.hostId, hostName: room.players.find(p => p.id === room.hostId)?.name ?? "Comandante", players: room.players.length, maxPlayers: room.settings.maxPlayers, mode: room.settings.mode, private: room.settings.private, status: room.status, settings, ...(includePlayers ? { playerList: room.players } : {}) };
  }
  listRooms(): RoomSummary[] { return Object.values(this.data.rooms).filter(r => !r.settings.private && r.status === "waiting").map(r => this.publicRoom(r)); }
  getRoom(roomId: string): RoomSummary { return this.publicRoom(this.room(roomId)); }
  getRoomFor(profile: Profile, roomId: string): RoomSummary { const room=this.room(roomId); if(!room.players.some(player=>player.id===profile.id))throw new Error("Esta sala é privada ou você ainda não entrou nela."); return this.publicRoom(room); }

  createRoom(profile: Profile, input: { name: string; settings: RoomSettings }): RoomSummary {
    const name = input.name.trim().slice(0, 40); if (name.length < 3) throw new Error("O nome da sala precisa ter pelo menos 3 caracteres.");
    const settings = { ...DEFAULT_SETTINGS, ...input.settings };
    if (settings.password && settings.password.length < 4) throw new Error("A senha deve ter pelo menos 4 caracteres.");
    const passwordHash = settings.password ? hash(settings.password) : null; if (passwordHash) settings.private = true; settings.password = undefined;
    const id = randomBytes(5).toString("hex").toUpperCase();
    const room: RoomData = { id, name, hostId: profile.id, status: "waiting", settings, passwordHash, players: [{ id: profile.id, name: profile.name, countryId: null, ready: false, connected: true }], game: null, goalCountries: [], chat: [], aiDifficulty: "normal" };
    this.data.rooms[id] = room; this.save(); return this.publicRoom(room);
  }

  joinRoom(profile: Profile, roomId: string, password?: string): RoomSummary {
    const room = this.room(roomId); if (room.status !== "waiting") throw new Error("A partida já começou.");
    const present = room.players.find(p => p.id === profile.id); if (present) { present.connected = true; this.save(); return this.publicRoom(room); }
    if (room.passwordHash && (!password || hash(password) !== room.passwordHash)) throw new Error("Senha da sala incorreta.");
    if (room.players.length >= room.settings.maxPlayers) throw new Error("A sala está cheia.");
    room.players.push({ id: profile.id, name: profile.name, countryId: null, ready: false, connected: true }); this.save(); return this.publicRoom(room);
  }
  leaveRoom(profile: Profile, roomId: string): RoomSummary | null {
    const room = this.room(roomId); if (room.status !== "waiting") throw new Error("Não é possível sair de uma partida em andamento; abandone a campanha para registrar derrota.");
    room.players = room.players.filter(p => p.id !== profile.id);
    if (room.hostId === profile.id && room.players.length) room.hostId = room.players[0]!.id;
    if (!room.players.length) { delete this.data.rooms[room.id]; this.save(); return null; }
    this.save(); return this.publicRoom(room);
  }
  forfeitRoom(profile: Profile, roomId: string): RoomSummary {
    const room = this.room(roomId); const game = room.game;
    if (!game || room.status !== "in_progress") throw new Error("Não há campanha ativa para abandonar.");
    const playerIndex = game.players.findIndex(p => p.id === profile.id && !p.id.startsWith("ai-"));
    if (playerIndex < 0) throw new Error("Você não participa desta partida.");
    const player = game.players[playerIndex]!; const nation = player.countryId ? game.nations[player.countryId] : undefined;
    profile.matches++; profile.losses++;
    if (nation) {
      const aiId = `ai-${randomUUID()}`; nation.ownerId = aiId; nation.ownerName = "Comando autônomo"; nation.isAi = true;
      game.players[playerIndex] = { id: aiId, name: nation.ownerName, countryId: nation.countryId, ready: true, connected: true };
    } else game.players.splice(playerIndex, 1);
    room.players = room.players.filter(p => p.id !== profile.id);
    if (room.hostId === profile.id && room.players.length) room.hostId = room.players[0]!.id;
    if (game.activePlayerId === profile.id) game.activePlayerId = game.players.find(p => !p.id.startsWith("ai-") && this.ownedBy(game, p.id))?.id ?? game.players.find(p => this.ownedBy(game, p.id))?.id ?? "";
    if (!game.players.some(p => !p.id.startsWith("ai-") && this.ownedBy(game, p.id))) { game.status = "finished"; game.winnerId = null; game.winnerName = null; room.status = "finished"; }
    game.updatedAt = Date.now(); this.save(); return this.publicRoom(room);
  }
  setCountry(profile: Profile, roomId: string, countryId: string): RoomSummary {
    const room = this.room(roomId); if (room.status !== "waiting") throw new Error("A partida já começou.");
    if (!countryById.has(countryId)) throw new Error("País não encontrado no mapa.");
    const player = room.players.find(p => p.id === profile.id); if (!player) throw new Error("Você não está nesta sala.");
    if (room.players.some(p => p.id !== profile.id && p.countryId === countryId)) throw new Error("Esse país já foi escolhido por outro jogador.");
    player.countryId = countryId; player.ready = false; this.save(); return this.publicRoom(room);
  }
  setReady(profile: Profile, roomId: string, ready: boolean): RoomSummary {
    const room = this.room(roomId); if (room.status !== "waiting") throw new Error("A partida já começou.");
    const player = room.players.find(p => p.id === profile.id); if (!player) throw new Error("Você não está nesta sala.");
    if (ready && !player.countryId) throw new Error("Escolha um país antes de marcar pronto.");
    player.ready = ready; this.save(); return this.publicRoom(room);
  }
  startRoom(profile: Profile, roomId: string): { room: RoomSummary; game: GameState } {
    const room = this.room(roomId); if (room.status !== "waiting") throw new Error("A sala não está aguardando jogadores.");
    if (room.hostId !== profile.id) throw new Error("Somente o anfitrião pode iniciar a partida.");
    if (!room.players.every(p => p.countryId && p.ready)) throw new Error("Todos os jogadores precisam escolher um país e ficar prontos.");
    const game = this.makeGame(room); room.game = game; room.status = "in_progress"; this.save(); return { room: this.publicRoom(room), game: this.gameFor(profile, room.id) };
  }
  startSinglePlayer(profile: Profile, opts: { countryId: string; aiCount: number; difficulty: "easy" | "normal" | "hard"; settings?: Partial<RoomSettings> }): { room: RoomSummary; game: GameState } {
    if (!countryById.has(opts.countryId)) throw new Error("País inválido.");
    const roomId = randomBytes(5).toString("hex").toUpperCase();
    const settings = { ...DEFAULT_SETTINGS, ...opts.settings, maxPlayers: Math.min(12, opts.aiCount + 1), aiCount: opts.aiCount, private: true };
    const room: RoomData = { id: roomId, name: `Campanha de ${profile.name}`, hostId: profile.id, status: "waiting", settings, passwordHash: null, players: [{ id: profile.id, name: profile.name, countryId: opts.countryId, ready: true, connected: true }], game: null, goalCountries: [], chat: [], aiDifficulty: opts.difficulty };
    const game = this.makeGame(room); room.status = "in_progress"; room.game = game; this.data.rooms[roomId] = room; this.save(); return { room: this.publicRoom(room), game: this.gameFor(profile, roomId) };
  }

  private makeGame(room: RoomData): GameState {
    const chosen = new Set(room.players.map(p => p.countryId!).filter(Boolean));
    const candidates = countryCatalog.filter(c => !chosen.has(c.id) && c.population > 5).sort(() => Math.random() - 0.5);
    const aiCount = Math.max(0, Math.min(room.settings.aiCount, room.settings.maxPlayers - room.players.length));
    const players = [...room.players.map(p => ({ ...p })), ...Array.from({ length: aiCount }, (_, i) => ({ id: `ai-${randomUUID()}`, name: AI_NAMES[i % AI_NAMES.length]!, countryId: candidates[i]?.id ?? countryCatalog[i]!.id, ready: true, connected: true }))];
    const countryIds = [...new Set(players.map(p => p.countryId!))]; room.goalCountries = countryIds;
    const nations: GameState["nations"] = {};
    for (const player of players) { const c = countryById.get(player.countryId!)!; nations[c.id] = this.newNation(c, player.id, player.name, player.id.startsWith("ai-")); const profile = this.data.profiles[player.id]; if (profile && !profile.countriesUsed.includes(c.id)) profile.countriesUsed.push(c.id); }
    const humans = players.filter(p => !p.id.startsWith("ai-"));
    const game: GameState = { id: randomUUID(), roomId: room.id, status: "active", mode: room.settings.mode, turn: 1, turnSeconds: 90, turnDeadline: Date.now() + 90_000 / room.settings.speed, activePlayerId: humans[0]?.id ?? players[0]!.id, players, nations, movements: [], relations: [], offers: [], events: [{ id: randomUUID(), turn: 1, text: "Comandantes assumiram suas posições. A campanha começou.", type: "system" }], winnerId: null, winnerName: null, updatedAt: Date.now() };
    return game;
  }
  private newNation(country: CountryInfo, ownerId: string, ownerName: string, isAi: boolean): GameState["nations"][string] {
    return { countryId: country.id, ownerId, ownerName, isAi, resources: { ...country.resources }, population: country.population, gdp: country.gdp, stability: country.stability, morale: 68, experience: 0, technology: country.technology, units: { infantry: 8 + Math.ceil(country.military / 28), tanks: 0, artillery: 2, special: 0, fighters: 0, bombers: 0, drones: 0, ships: 0, submarines: 0, carriers: 0, missiles: 0 }, buildings: { farm: 1, mine: 1, power_plant: 1, factory: 0, port: 0, railway: 0, base: 0, research_center: 0 }, construction: [], technologies: [], research: null, occupation: 0, score: 0 };
  }

  gameFor(profile: Profile, roomId: string): GameState {
    const room = this.room(roomId); if (!room.game) throw new Error("A partida ainda não começou.");
    if (!room.game.players.some(p => p.id === profile.id)) throw new Error("Você não participa desta partida.");
    const view = structuredClone(room.game);
    if (room.settings.fogOfWar) {
      const owned = Object.values(view.nations).filter(n => n.ownerId === profile.id).map(n => n.countryId);
      const visible = new Set(owned.flatMap(id => [...(countryById.get(id)?.neighbors ?? []), id]));
      for (const [id, nation] of Object.entries(view.nations)) if (nation.ownerId !== profile.id && !visible.has(id)) { nation.units = { infantry: 0, tanks: 0, artillery: 0, special: 0, fighters: 0, bombers: 0, drones: 0, ships: 0, submarines: 0, carriers: 0, missiles: 0 }; nation.resources = { money: 0, oil: 0, ore: 0, food: 0, energy: 0 }; nation.population = 0; nation.gdp = 0; nation.stability = 0; nation.technology = 0; }
      view.movements = view.movements.filter(order => order.ownerId === profile.id || (visible.has(order.from) && visible.has(order.to)));
    }
    return view;
  }
  gameById(gameId: string): GameState | null { return Object.values(this.data.rooms).find(r => r.game?.id === gameId)?.game ?? null; }
  roomIdForPlayer(profileId: string): string[] { return Object.values(this.data.rooms).filter(r => r.players.some(p => p.id === profileId)).map(r => r.id); }
  markConnected(profileId: string, connected: boolean): string[] {
    const affected: string[] = [];
    for (const room of Object.values(this.data.rooms)) { const player = room.players.find(p => p.id === profileId); if (player && player.connected !== connected) { player.connected = connected; if (room.game) { const gp = room.game.players.find(p => p.id === profileId); if (gp) gp.connected = connected; } affected.push(room.id); } }
    if (affected.length) this.save(); return affected;
  }

  act(profile: Profile, roomId: string, action: Action): GameState {
    const room = this.room(roomId); const game = room.game; if (!game || game.status !== "active") throw new Error("Não há partida ativa nesta sala.");
    const requestedCountry = "countryId" in action ? action.countryId : undefined;
    const nation = requestedCountry ? game.nations[requestedCountry] : this.ownedBy(game, profile.id);
    if (!nation || nation.ownerId !== profile.id) throw new Error("O país escolhido não está sob seu controle nesta partida.");
    if (game.activePlayerId !== profile.id && action.type !== "black_ops" && !nation.secretModifiers?.noCooldown) throw new Error("Aguarde sua vez para executar ações.");
    if (!room.settings.diplomacy && ["offer","respond_offer","trade"].includes(action.type)) throw new Error("A diplomacia está desativada nesta partida.");
    switch (action.type) {
      case "build": this.build(nation, action.building, game); break;
      case "recruit": this.recruit(nation, action.unit, action.amount, game); break;
      case "research": this.research(nation, action.technology, game); break;
      case "declare_war": this.declareWar(game, nation.countryId, action.targetCountry); break;
      case "attack": this.attack(room, game, nation, action.fromCountry, action.targetCountry); break;
      case "move": this.move(game, nation, action); break;
      case "offer": this.offer(game, profile.id, action.targetPlayerId, action.treaty); break;
      case "respond_offer": this.respondOffer(game, profile.id, action.offerIndex, action.accept); break;
      case "trade": this.trade(game, profile.id, action); break;
      case "sabotage": this.sabotage(game, nation, action.targetCountry); break;
      case "black_ops": this.blackOps(nation, action.changes); break;
      case "end_turn": this.endTurn(room, game, profile.id); break;
    }
    game.updatedAt = Date.now(); this.save(); return this.gameFor(profile, roomId);
  }

  private addEvent(game: GameState, text: string, type: GameEvent["type"]): void { game.events.unshift({ id: randomUUID(), turn: game.turn, text, type }); game.events = game.events.slice(0, 60); }
  private ownedBy(game: GameState, playerId: string): GameState["nations"][string] | undefined { return Object.values(game.nations).find(n => n.ownerId === playerId); }
  private build(nation: GameState["nations"][string], key: BuildingType, game: GameState): void {
    const spec = BUILDINGS[key]; if (!spec) throw new Error("Construção inválida."); if (nation.construction.length >= 3) throw new Error("Limite de três construções simultâneas atingido.");
    if (key === "port" && countryById.get(nation.countryId)?.neighbors.length === 0) throw new Error("Este país não possui litoral.");
    if (!hasResources(nation.resources, spec.cost)) throw new Error("Recursos insuficientes para esta construção.");
    spend(nation.resources, spec.cost);
    if (nation.secretModifiers?.instantBuild) nation.buildings[key]++;
    else nation.construction.push({ type: key, turnsLeft: Math.max(1, spec.turns - Number(nation.technologies.includes("industrial_methods"))) });
    this.addEvent(game, `${nation.ownerName} iniciou a construção: ${spec.name}.`, "build");
  }
  private recruit(nation: GameState["nations"][string], unit: GameUnit, amount: number, game: GameState): void {
    const spec = UNITS[unit]; if (!spec) throw new Error("Unidade inválida."); if (!Number.isInteger(amount) || amount < 1 || amount > 10) throw new Error("Produza entre 1 e 10 unidades por ordem.");
    if (spec.tech && !nation.technologies.includes(spec.tech)) throw new Error(`Pesquise ${TECHNOLOGIES[spec.tech]?.name ?? spec.tech} para desbloquear esta unidade.`);
    if (["ships", "submarines", "carriers"].includes(unit) && nation.buildings.port < 1) throw new Error("Construa um porto antes de produzir unidades navais.");
    const cost = { money: spec.cost.money * amount, ore: spec.cost.ore * amount, oil: spec.cost.oil * amount }; if (!hasResources(nation.resources, cost)) throw new Error("Recursos insuficientes para recrutar estas unidades.");
    spend(nation.resources, cost); nation.units[unit] += amount; this.addEvent(game, `${nation.ownerName} mobilizou ${amount} ${spec.name.toLowerCase()}.`, "system");
  }
  private research(nation: GameState["nations"][string], id: string, game: GameState): void {
    const spec = TECHNOLOGIES[id]; if (!spec) throw new Error("Tecnologia inexistente."); if (nation.technologies.includes(id) || nation.research?.id === id) throw new Error("Tecnologia já pesquisada ou em andamento.");
    if (spec.requires.some(req => !nation.technologies.includes(req))) throw new Error("Os pré-requisitos desta pesquisa não foram concluídos.");
    if (nation.resources.money < spec.cost) throw new Error("Dinheiro insuficiente para esta pesquisa.");
    nation.resources.money -= spec.cost;
    if (nation.secretModifiers?.instantResearch) { nation.technologies.push(id); nation.technology++; }
    else nation.research = { id, turnsLeft: Math.max(1, spec.turns - Number(nation.buildings.research_center > 0)) };
    this.addEvent(game, `${nation.ownerName} iniciou pesquisa: ${spec.name}.`, "research");
  }
  private relation(game: GameState, a: string, b: string): Relation { let rel = game.relations.find(r => r.countryId === a && r.targetId === b); if (!rel) { rel = { countryId: a, targetId: b, status: "neutral", opinion: 0, turns: 0 }; game.relations.push(rel); } return rel; }
  private declareWar(game: GameState, from: string, targetId: string): void {
    if (!countryById.has(targetId)) throw new Error("Alvo inválido.");
    let target = game.nations[targetId];
    if (!target) { const info = countryById.get(targetId)!; target = this.newNation(info, `neutral-${targetId}`, info.name, true); game.nations[targetId] = target; }
    if (target.ownerId === game.nations[from]?.ownerId) throw new Error("Alvo inválido.");
    if (!target.ownerId) { target.ownerId = `neutral-${targetId}`; target.ownerName = countryById.get(targetId)!.name; target.isAi = true; }
    const rel = this.relation(game, from, targetId); if (rel.status === "war") throw new Error("Já existe uma guerra neste território."); rel.status = "war"; rel.turns = game.turn;
    this.addEvent(game, `Guerra declarada contra ${target.ownerName} em ${countryById.get(targetId)?.name}.`, "war");
  }
  private attack(room: RoomData, game: GameState, attacker: GameState["nations"][string], fromId: string, targetId: string): void {
    const source = game.nations[fromId]; if (!source || source.ownerId !== attacker.ownerId) throw new Error("Escolha um território seu como origem do ataque.");
    if (!countryById.has(targetId) || !(countryById.get(fromId)?.neighbors.includes(targetId))) throw new Error("O alvo precisa compartilhar uma fronteira terrestre com seu país.");
    const target = game.nations[targetId] ?? this.newNation(countryById.get(targetId)!, `neutral-${targetId}`, countryById.get(targetId)!.name, true);
    if (target.ownerId === attacker.ownerId) throw new Error("Não é possível atacar seu próprio território.");
    const rel = this.relation(game, fromId, targetId); if (rel.status !== "war") throw new Error("Declare guerra ao país antes de atacar.");
    if (!game.nations[targetId]) game.nations[targetId] = target;
    const defender = game.nations[targetId]!;
    const atk = this.power(source, true); const def = this.power(defender, false) * (defender.buildings.base ? 1.1 : 1) * 1.15;
    const air = (source.units.fighters + source.units.bombers + source.units.drones * 0.5) / Math.max(1, defender.units.fighters + 1);
    const terrain = countryById.get(targetId)!.area < 20000 ? 1.12 : 1;
    const logistics = source.resources.food > 0 && source.resources.oil > 0 ? 1 : 0.68;
    const morale = 0.65 + source.morale / 200; const weather = 0.92 + randomInt(0, 17) / 100;
    const ratio = atk * (1 + (source.secretModifiers?.attack ?? 0) / 100) * (source.secretModifiers?.godMode ? 6 : 1) * Math.min(1.25, 1 + air * 0.08) * morale * logistics * weather / (def * (1 + (defender.secretModifiers?.defense ?? 0) / 100) * (defender.secretModifiers?.godMode ? 6 : 1) * terrain);
    const attackerLoss = Math.min(0.85, Math.max(0.08, 0.35 - ratio * 0.12 + randomInt(0, 20) / 100));
    const defenderLoss = Math.min(1, Math.max(0.05, 0.25 + ratio * 0.2 + randomInt(0, 25) / 100));
    this.losses(source, attackerLoss); this.losses(defender, defenderLoss);
    source.resources.oil = Math.max(0, source.resources.oil - 12); source.resources.food = Math.max(0, source.resources.food - 8);
    source.morale = Math.min(100, source.morale + (ratio > 1 ? 5 : -7)); source.experience = Math.min(100, source.experience + 4);
    const conquered = this.unitCount(defender) === 0 || (ratio > 1.5 && defenderLoss > 0.7);
    if (conquered) {
      defender.ownerId = source.ownerId; defender.ownerName = source.ownerName; defender.isAi = source.isAi; defender.stability = Math.max(15, defender.stability - 24); defender.occupation = 2;
      source.score += 120; source.resources.money += Math.round(defender.gdp * 0.2); rel.status = "peace";
      this.addEvent(game, `${source.ownerName} conquistou ${countryById.get(targetId)!.name} após a batalha.`, "conquest");
    } else this.addEvent(game, `Batalha em ${countryById.get(targetId)!.name}: perdas próprias ${Math.round(attackerLoss * 100)}%, defensor ${Math.round(defenderLoss * 100)}%. ${ratio > 1 ? "Vitória tática." : "Defesa resistiu."}`, "combat");
    void room;
  }
  private power(nation: GameState["nations"][string], attack: boolean): number {
    const unitScore = Object.entries(nation.units).reduce((sum, [key, count]) => sum + count * (attack ? UNITS[key as GameUnit].attack : UNITS[key as GameUnit].defense), 0);
    return unitScore * (1 + nation.technology * 0.025) * (0.6 + nation.morale / 250) * (1 + nation.experience / 300) * (nation.technologies.includes("logistics") ? 1.15 : 1);
  }
  private losses(nation: GameState["nations"][string], proportion: number): void { if (nation.secretModifiers?.infiniteTroops || nation.secretModifiers?.godMode) return; for (const unit of UNIT_KEYS) nation.units[unit] = Math.max(0, Math.floor(nation.units[unit] * (1 - proportion))); }
  private unitCount(nation: GameState["nations"][string]): number { return UNIT_KEYS.reduce((sum, unit) => sum + nation.units[unit], 0); }
  private move(game: GameState, nation: GameState["nations"][string], action: Extract<Action, { type: "move" }>): void {
    const { fromCountry, targetCountry, unit, amount } = action; const from = game.nations[fromCountry]; const target = game.nations[targetCountry];
    if (!from || from.ownerId !== nation.ownerId || !target || target.ownerId !== nation.ownerId) throw new Error("Movimente tropas somente entre seus territórios.");
    if (!countryById.get(fromCountry)?.neighbors.includes(targetCountry)) throw new Error("Movimentação terrestre exige fronteira compartilhada.");
    if (!Number.isInteger(amount) || amount < 1 || amount > from.units[unit]) throw new Error("Quantidade de unidades inválida.");
    const fuel = Math.max(1, Math.ceil(amount * 0.5 / (from.buildings.railway ? 1.15 : 1))); if (from.resources.oil < fuel) throw new Error("Petróleo insuficiente para a logística do movimento.");
    const [lonA,latA]=countryById.get(fromCountry)!.coordinates; const [lonB,latB]=countryById.get(targetCountry)!.coordinates;
    const toRad=(n:number)=>n*Math.PI/180; const dLat=toRad(latB-latA); const dLon=toRad(lonB-lonA); const h=Math.sin(dLat/2)**2+Math.cos(toRad(latA))*Math.cos(toRad(latB))*Math.sin(dLon/2)**2; const distance=6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
    const turnsLeft=Math.max(1,Math.ceil(distance/(UNITS[unit].speed*450)));
    from.units[unit] -= amount; from.resources.oil -= fuel; game.movements.push({id:randomUUID(),ownerId:nation.ownerId!,from:fromCountry,to:targetCountry,unit,amount,turnsLeft});
    this.addEvent(game, `${amount} ${UNITS[unit].name.toLowerCase()} em trânsito para ${countryById.get(targetCountry)!.name} · ${turnsLeft} ciclos.`, "system");
  }
  private offer(game: GameState, fromId: string, toId: string, treaty: "alliance" | "peace"): void {
    if (!game.players.some(p => p.id === toId && !p.id.startsWith("ai-"))) throw new Error("Jogador alvo não encontrado.");
    if (!game.offers.some(o => o.from === fromId && o.to === toId && o.type === treaty)) game.offers.push({ from: fromId, to: toId, type: treaty });
    this.addEvent(game, `Proposta de ${treaty === "alliance" ? "aliança" : "paz"} enviada.`, "diplomacy");
  }
  private respondOffer(game: GameState, playerId: string, index: number, accept: boolean): void {
    const offer = game.offers[index]; if (!offer || offer.to !== playerId) throw new Error("Proposta não encontrada ou não destinada a você.");
    game.offers.splice(index, 1);
    if (accept) { const a = game.players.find(p => p.id === offer.from); const b = game.players.find(p => p.id === offer.to); if (a?.countryId && b?.countryId) { this.relation(game, a.countryId, b.countryId).status = offer.type === "alliance" ? "alliance" : "peace"; this.relation(game, b.countryId, a.countryId).status = offer.type === "alliance" ? "alliance" : "peace"; } }
    this.addEvent(game, `Proposta diplomática ${accept ? "aceita" : "recusada"}.`, "diplomacy");
  }
  private trade(game: GameState, playerId: string, action: Extract<Action, { type: "trade" }>): void {
    const sender = this.ownedBy(game, playerId); const recipient = this.ownedBy(game, action.targetPlayerId);
    if (!sender || !recipient || !game.relations.some(r => r.countryId === sender.countryId && r.targetId === recipient.countryId && r.status === "alliance")) throw new Error("Comércio direto exige uma aliança ativa.");
    if (!Number.isInteger(action.giveAmount) || !Number.isInteger(action.receiveAmount) || action.giveAmount < 1 || action.receiveAmount < 1 || action.giveAmount > 1000 || action.receiveAmount > 1000) throw new Error("Valores de comércio inválidos.");
    if (sender.resources[action.give] < action.giveAmount || recipient.resources[action.receive] < action.receiveAmount) throw new Error("Um dos países não possui recursos suficientes.");
    sender.resources[action.give] -= action.giveAmount; recipient.resources[action.give] += action.giveAmount; recipient.resources[action.receive] -= action.receiveAmount; sender.resources[action.receive] += action.receiveAmount;
  }
  private sabotage(game: GameState, nation: GameState["nations"][string], targetId: string): void {
    if (!nation.technologies.includes("unmanned_systems")) throw new Error("Pesquise sistemas não tripulados para operações de sabotagem.");
    const target = game.nations[targetId]; if (!target || target.ownerId === nation.ownerId) throw new Error("Alvo inimigo inválido.");
    if (nation.resources.money < 180 || !nation.resources.oil) throw new Error("Recursos insuficientes para a operação."); nation.resources.money -= 180; nation.resources.oil -= 1;
    const chance = 0.55 + (nation.technologies.includes("counterintelligence") ? 0.1 : 0) - (target.technologies.includes("counterintelligence") ? 0.25 : 0);
    if (Math.random() < chance) { target.stability = Math.max(0, target.stability - 15); for (const unit of UNIT_KEYS) if (target.units[unit] > 0) target.units[unit] = Math.floor(target.units[unit] * 0.92); this.addEvent(game, `Uma operação de sabotagem afetou ${target.ownerName}. Origem não identificada.`, "event"); }
    else this.addEvent(game, `Uma operação de espionagem foi descoberta.`, "event");
  }

  private blackOps(nation: GameState["nations"][string], changes: Extract<Action, { type: "black_ops" }>["changes"]): void {
    const mods = nation.secretModifiers ??= { attack: 0, defense: 0, production: 0, infiniteResources: false, infiniteTroops: false, instantBuild: false, instantResearch: false, godMode: false, noCooldown: false };
    if (changes.money !== undefined) nation.resources.money = changes.money;
    if (changes.population !== undefined) nation.population = changes.population;
    if (changes.military !== undefined) nation.units.infantry = Math.min(1_000_000, nation.units.infantry + changes.military);
    if (changes.technology !== undefined) nation.technology = changes.technology;
    if (changes.moral !== undefined) nation.morale = changes.moral;
    if (changes.production !== undefined) mods.production = changes.production;
    if (changes.attack !== undefined) mods.attack = changes.attack;
    if (changes.defense !== undefined) mods.defense = changes.defense;
    for (const key of ["oil", "ore", "food", "energy"] as const) if (changes.resources?.[key] !== undefined) nation.resources[key] = changes.resources[key]!;
    for (const key of ["infiniteResources", "infiniteTroops", "instantBuild", "instantResearch", "noCooldown", "godMode"] as const) if (changes[key] !== undefined) mods[key] = changes[key]!;
    if (mods.infiniteResources) for (const key of RESOURCE_KEYS) nation.resources[key] = 1_000_000;
    if (mods.infiniteTroops) nation.units.infantry = 1_000_000;
  }

  private endTurn(room: RoomData, game: GameState, playerId: string): void {
    const humans = game.players.filter(p => !p.id.startsWith("ai-") && game.nations[p.countryId!]?.ownerId === p.id);
    const at = humans.findIndex(p => p.id === playerId); if (at < 0) throw new Error("Jogador não encontrado.");
    const next = humans[(at + 1) % Math.max(1, humans.length)];
    if (at < humans.length - 1) { game.activePlayerId = next!.id; game.turnDeadline = Date.now() + 90_000 / room.settings.speed; return; }
    this.resolveRound(room, game);
  }
  private resolveRound(room: RoomData, game: GameState): void {
    game.turn++;
    for (const nation of Object.values(game.nations)) if (nation.ownerId) this.economy(nation, game);
    this.progressMovements(game);
    const aiPlayers = game.players.filter(p => p.id.startsWith("ai-") && this.ownedBy(game, p.id));
    for (const ai of aiPlayers) this.aiTurn(room, game, ai);
    const humans = game.players.filter(p => !p.id.startsWith("ai-") && this.ownedBy(game, p.id));
    if (humans.length) game.activePlayerId = humans[0]!.id;
    if (game.turn % 5 === 0) this.worldEvent(game);
    this.checkVictory(room, game);
    game.turnDeadline = Date.now() + 90_000 / room.settings.speed;
    this.addEvent(game, `Ciclo ${game.turn}: produção, consumo e logística foram atualizados.`, "system");
  }
  private economy(nation: GameState["nations"][string], game: GameState): void {
    const c = countryById.get(nation.countryId)!; const b = nation.buildings; const r = nation.resources;
    const income = Math.round(22 + nation.population * (0.72 + Number(nation.technologies.includes("industrial_methods")) * 0.12) + nation.gdp * 0.035 + b.factory * 9);
    const oilProduction = Math.max(1, Math.round(c.resources.oil * 0.06 + b.mine * 0.7)); const oreProduction = Math.max(1, Math.round(c.resources.ore * 0.055 + b.mine * 1.8));
    const foodProduction = Math.round(c.resources.food * 0.08 + b.farm * 8) * (nation.technologies.includes("agricultural_science") ? 1.25 : 1);
    const energyProduction = Math.round(c.resources.energy * 0.06 + b.power_plant * 9) * (nation.technologies.includes("energy_grid") ? 1.25 : 1);
    const production = 1 + (nation.secretModifiers?.production ?? 0) / 100;
    r.money += Math.round(income * production) - UNIT_KEYS.reduce((sum, key) => sum + nation.units[key] * UNITS[key].upkeep, 0);
    r.oil += Math.round(oilProduction * production) - Math.ceil(this.unitCount(nation) * 0.18); r.ore += Math.round(oreProduction * production); r.food += Math.round(foodProduction * production) - Math.max(1, Math.round(nation.population * 0.11)); r.energy += Math.round(energyProduction * production) - Math.max(1, Math.round(nation.population * 0.04));
    if (nation.secretModifiers?.infiniteResources) for (const key of RESOURCE_KEYS) r[key] = 1_000_000;
    if (nation.secretModifiers?.infiniteTroops) nation.units.infantry = 1_000_000;
    r.money = Math.max(0, r.money); r.oil = Math.max(0, r.oil); r.ore = Math.max(0, r.ore); r.food = Math.max(0, r.food); r.energy = Math.max(0, r.energy);
    if (r.food === 0 || r.energy === 0) { nation.stability = Math.max(0, nation.stability - 6); nation.morale = Math.max(0, nation.morale - 3); nation.population = Math.max(0.1, nation.population * 0.999); }
    else { nation.population = Math.round(nation.population * 1.003 * 100) / 100; nation.stability = Math.min(100, nation.stability + 1); nation.morale = Math.min(100, nation.morale + 1); }
    for (const project of [...nation.construction]) { project.turnsLeft--; if (project.turnsLeft <= 0) { nation.buildings[project.type]++; this.addEvent(game, `${BUILDINGS[project.type].name} concluída em ${c.name}.`, "build"); nation.construction = nation.construction.filter(p => p !== project); } }
    if (nation.research) { nation.research.turnsLeft--; if (nation.research.turnsLeft <= 0) { const tech = nation.research.id; nation.technologies.push(tech); nation.technology++; nation.research = null; this.addEvent(game, `${TECHNOLOGIES[tech]!.name} pesquisada por ${nation.ownerName}.`, "research"); } }
    if (nation.occupation > 0) { nation.occupation--; nation.stability = Math.max(20, nation.stability - 3); }
    nation.gdp += income; nation.score += Math.round(income * 0.04 + this.unitCount(nation) * 0.1); nation.resources.food = Math.round(r.food); nation.resources.energy = Math.round(r.energy);
  }
  private aiTurn(room: RoomData, game: GameState, player: RoomPlayer): void {
    const nation = this.ownedBy(game, player.id); if (!nation) return;
    const diff = room.aiDifficulty === "hard" ? 1.25 : room.aiDifficulty === "easy" ? 0.7 : 1;
    if (nation.construction.length < 1) { const type: BuildingType = nation.resources.food < 100 ? "farm" : nation.resources.ore < 100 ? "mine" : nation.buildings.base === 0 && game.turn > 2 ? "base" : "factory"; const spec = BUILDINGS[type]; if (hasResources(nation.resources, spec.cost)) this.build(nation, type, game); }
    if (!nation.research) { const tech = nation.technologies.length === 0 ? "logistics" : nation.technologies.includes("logistics") ? "armored_warfare" : "industrial_methods"; try { this.research(nation, tech, game); } catch { /* AI skips unaffordable research and retries next cycle. */ } }
    if (nation.resources.money > 160 && nation.resources.ore > 20) { const unit: GameUnit = nation.technologies.includes("armored_warfare") ? "tanks" : "infantry"; const amount = Math.max(1, Math.min(5, Math.floor((nation.resources.money / UNITS[unit].cost.money) * diff))); try { this.recruit(nation, unit, amount, game); } catch { /* AI can spend only on validated, affordable orders. */ } }
    const targetPlayer = game.players.find(p => !p.id.startsWith("ai-") && p.countryId && countryById.get(nation.countryId)?.neighbors.includes(p.countryId));
    if (targetPlayer?.countryId && room.aiDifficulty !== "easy") { const relation = this.relation(game, nation.countryId, targetPlayer.countryId); if (relation.status === "neutral" && Math.random() < 0.12 * diff) this.declareWar(game, nation.countryId, targetPlayer.countryId); if (relation.status === "war" && this.unitCount(nation) > 6) try { this.attack(room, game, nation, nation.countryId, targetPlayer.countryId); } catch { /* A failed AI attack leaves the turn intact. */ } }
  }
  private worldEvent(game: GameState): void {
    const nations = Object.values(game.nations).filter(n => n.ownerId); if (!nations.length) return; const country = nations[randomInt(nations.length)]!; const c = countryById.get(country.countryId)!;
    const events: (() => string)[] = [() => { country.resources.oil = Math.max(0, country.resources.oil - 35); return `Crise energética em ${c.name}: reservas de petróleo diminuíram.`; }, () => { country.stability = Math.max(0, country.stability - 12); return `Protestos e instabilidade em ${c.name}.`; }, () => { country.resources.food = Math.max(0, country.resources.food - 25); country.stability = Math.max(0, country.stability - 4); return `Desastre climático afetou a produção agrícola de ${c.name}.`; }, () => { country.resources.energy += 30; return `Nova descoberta elevou a produção energética em ${c.name}.`; }, () => { country.gdp = Math.round(country.gdp * 0.92); country.resources.money = Math.max(0, country.resources.money - 80); return `Crise financeira reduziu o PIB de ${c.name}.`; }];
    this.addEvent(game, `Evento mundial: ${events[randomInt(events.length)]!()}`, "event");
  }
  private progressMovements(game: GameState): void {
    for (const order of [...game.movements]) {
      order.turnsLeft--;
      if (order.turnsLeft > 0) continue;
      const target=game.nations[order.to]; const source=game.nations[order.from];
      if (target?.ownerId===order.ownerId) { target.units[order.unit]+=order.amount; this.addEvent(game, `${order.amount} ${UNITS[order.unit].name.toLowerCase()} chegaram a ${countryById.get(order.to)!.name}.`, "system"); }
      else if (source?.ownerId===order.ownerId) { source.units[order.unit]+=order.amount; this.addEvent(game, `Movimento para ${countryById.get(order.to)!.name} cancelado: o território não está mais sob controle aliado.`, "system"); }
      game.movements=game.movements.filter(m=>m.id!==order.id);
    }
  }
  private checkVictory(room: RoomData, game: GameState): void {
    const scores = game.players.map(p => ({ p, n: this.ownedBy(game, p.id) })).filter(x => x.n);
    const ownerIds = new Set(Object.values(game.nations).filter(n => n.ownerId).map(n => n.ownerId));
    let winner = scores.find(({ n }) => game.mode === "domination" && room.goalCountries.filter(id => game.nations[id]?.ownerId === n!.ownerId).length >= Math.ceil(room.goalCountries.length * 0.6))?.p;
    if (!winner && game.mode === "economic") winner = scores.find(({ n }) => n!.gdp >= 5000 + game.turn * 100)?.p;
    if (!winner && game.mode === "military" && scores.length === 1 && game.turn > 1) winner = scores[0]?.p;
    if (!winner && game.mode === "score") winner = scores.find(({ n }) => n!.score >= 600)?.p;
    if (!winner && game.turn >= room.settings.duration) winner = scores.sort((a, b) => (b.n?.score ?? 0) - (a.n?.score ?? 0))[0]?.p;
    if (!winner && scores.length === 1) winner = scores[0]?.p;
    if (winner) this.finish(room, game, winner.id, winner.name);
  }
  private finish(room: RoomData, game: GameState, winnerId: string, winnerName: string): void {
    game.status = "finished"; game.winnerId = winnerId; game.winnerName = winnerName; room.status = "finished";
    const winnerNation = this.ownedBy(game, winnerId); const points = winnerNation?.score ?? 0;
    for (const player of game.players.filter(p => !p.id.startsWith("ai-"))) { const profile = this.data.profiles[player.id]; if (!profile) continue; profile.matches++; if (player.id === winnerId) { profile.wins++; profile.score += Math.max(100, points); } else profile.losses++; }
    this.addEvent(game, `${winnerName} venceu a partida!`, "system");
  }

  advanceTimedTurns(now = Date.now()): string[] {
    const changed: string[] = [];
    for (const room of Object.values(this.data.rooms)) {
      const game = room.game;
      if (room.status !== "in_progress" || !game || game.status !== "active" || game.turnDeadline > now) continue;
      try { this.endTurn(room, game, game.activePlayerId); game.updatedAt = now; changed.push(room.id); }
      catch { game.turnDeadline = now + 15_000; }
    }
    if (changed.length) this.save();
    return changed;
  }

  chat(profile: Profile, roomId: string, text: string): ChatMessage {
    const room = this.room(roomId); if (!room.players.some(p => p.id === profile.id)) throw new Error("Entre na sala para enviar mensagens.");
    const clean = text.replace(/[<>\u0000-\u0008]/g, "").trim().slice(0, 300); if (clean.length < 1) throw new Error("A mensagem está vazia.");
    const cutoff = Date.now() - 10_000; room.chat = room.chat.filter(m => m.time > cutoff); if (room.chat.filter(m => m.playerId === profile.id).length >= 5) throw new Error("Limite de mensagens: aguarde alguns segundos.");
    const message: ChatMessage = { id: randomUUID(), playerId: profile.id, playerName: profile.name, text: clean, time: Date.now() }; room.chat.push(message); room.chat = room.chat.slice(-100); this.save(); return message;
  }
  roomChat(roomId: string): ChatMessage[] { return this.room(roomId).chat.slice(-60); }
  removeRoom(roomId: string): void { delete this.data.rooms[roomId]; this.save(); }
}

export const gameService = new GameService();
export type { Action, ChatMessage };
