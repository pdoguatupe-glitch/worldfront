import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import { rateLimit } from "express-rate-limit";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { Profile, RoomSettings } from "@worldfront/shared";
import { BUILDINGS, TECHNOLOGIES, UNITS } from "../game/rules.js";
import { gameService, type Action } from "../game/gameService.js";

const app = express(); const httpServer = createServer(app);
const port = Number(process.env.PORT ?? 3001);
const allowedOrigins = new Set((process.env.FRONTEND_ORIGINS ?? process.env.FRONTEND_ORIGIN ?? "http://localhost:5173").split(",").map(value => value.trim()).filter(Boolean));
const corsOrigin = (requestOrigin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => callback(null, !requestOrigin || allowedOrigins.has(requestOrigin));
const io = new Server(httpServer, { cors: { origin: corsOrigin, methods: ["GET", "POST", "PATCH", "DELETE"] } });
const socketProfiles = new Map<string, Profile>();
const connectedSockets = new Map<string, number>();
app.use(cors({ origin: corsOrigin })); app.use(express.json({ limit: "20kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));

const settingsSchema = z.object({ maxPlayers: z.number().int().min(2).max(12).default(6), mode: z.enum(["domination", "economic", "military", "score", "time"]).default("domination"), private: z.boolean().default(false), password: z.string().max(64).optional(), duration: z.number().int().min(10).max(180).default(30), speed: z.number().int().min(1).max(4).default(1), fogOfWar: z.boolean().default(true), diplomacy: z.boolean().default(true), aiCount: z.number().int().min(0).max(8).default(3) });
const amount = z.number().int().min(1).max(10);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("build"), building: z.enum(["farm", "mine", "power_plant", "factory", "port", "railway", "base", "research_center"]), countryId: z.string().regex(/^\d{3}$/).optional() }),
  z.object({ type: z.literal("recruit"), unit: z.enum(["infantry", "tanks", "artillery", "special", "fighters", "bombers", "drones", "ships", "submarines", "carriers", "missiles"]), amount, countryId: z.string().regex(/^\d{3}$/).optional() }),
  z.object({ type: z.literal("research"), technology: z.string().max(60), countryId: z.string().regex(/^\d{3}$/).optional() }),
  z.object({ type: z.literal("declare_war"), targetCountry: z.string().regex(/^\d{3}$/), countryId: z.string().regex(/^\d{3}$/).optional() }),
  z.object({ type: z.literal("attack"), fromCountry: z.string().regex(/^\d{3}$/), targetCountry: z.string().regex(/^\d{3}$/) }),
  z.object({ type: z.literal("move"), fromCountry: z.string().regex(/^\d{3}$/), targetCountry: z.string().regex(/^\d{3}$/), unit: z.enum(["infantry", "tanks", "artillery", "special", "fighters", "bombers", "drones", "ships", "submarines", "carriers", "missiles"]), amount: z.number().int().min(1).max(10000) }),
  z.object({ type: z.literal("offer"), targetPlayerId: z.string().uuid(), treaty: z.enum(["alliance", "peace"]) }),
  z.object({ type: z.literal("respond_offer"), offerIndex: z.number().int().min(0), accept: z.boolean() }),
  z.object({ type: z.literal("trade"), targetPlayerId: z.string().uuid(), give: z.enum(["money", "oil", "ore", "food", "energy"]), giveAmount: z.number().int().min(1).max(1000), receive: z.enum(["money", "oil", "ore", "food", "energy"]), receiveAmount: z.number().int().min(1).max(1000) }),
  z.object({ type: z.literal("sabotage"), targetCountry: z.string().regex(/^\d{3}$/) }),
  z.object({ type: z.literal("black_ops"), countryId: z.string().regex(/^\d{3}$/), changes: z.object({ money: z.number().min(0).max(1_000_000).optional(), population: z.number().min(0.1).max(10_000).optional(), military: z.number().int().min(0).max(100_000).optional(), production: z.number().min(0).max(1000).optional(), technology: z.number().min(0).max(100).optional(), moral: z.number().min(0).max(100).optional(), resources: z.object({ oil: z.number().min(0).max(1_000_000).optional(), ore: z.number().min(0).max(1_000_000).optional(), food: z.number().min(0).max(1_000_000).optional(), energy: z.number().min(0).max(1_000_000).optional() }).optional(), infiniteResources: z.boolean().optional(), infiniteTroops: z.boolean().optional(), instantBuild: z.boolean().optional(), instantResearch: z.boolean().optional(), noCooldown: z.boolean().optional(), godMode: z.boolean().optional(), attack: z.number().min(0).max(1000).optional(), defense: z.number().min(0).max(1000).optional() }).strict() }),
  z.object({ type: z.literal("end_turn") }),
]);
const playerSchema = z.object({ name: z.string().trim().min(2).max(24) });
const routeRoomId = (req: Request): string => typeof req.params.id === "string" ? req.params.id : "";
const asyncRoute = (handler: (req: Request, res: Response, profile: Profile) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  try { const token = req.header("authorization")?.replace(/^Bearer\s+/i, ""); const profile = gameService.authenticate(token); Promise.resolve(handler(req, res, profile)).then(() => gameService.flush()).catch(next); }
  catch (error) { res.status(401).json({ error: error instanceof Error ? error.message : "Sessão inválida." }); }
};
const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(400).json({ error: error instanceof Error ? error.message : "A operação falhou." });
function sendRoomUpdate(roomId: string): void {
  const room = gameService.getRoom(roomId); io.to(`room:${roomId}`).emit("lobby:updated", room);
  if (room.status === "waiting") { io.emit("rooms:updated", gameService.listRooms()); return; }
  for (const socket of io.sockets.sockets.values()) {
    const profile = socketProfiles.get(socket.id); if (!profile || !socket.rooms.has(`room:${roomId}`)) continue;
    try { socket.emit("game:state", gameService.gameFor(profile, roomId)); } catch { /* A disconnected or finished session receives no private snapshot. */ }
  }
}
const withRoomUpdate = (handler: (req: Request, res: Response, profile: Profile) => unknown) => asyncRoute(async (req, res, profile) => {
  const result = await handler(req, res, profile); await gameService.flush(); const roomId = routeRoomId(req) || (result as { room?: { id?: string } })?.room?.id;
  if (roomId) { try { sendRoomUpdate(roomId); } catch { io.emit("rooms:updated", gameService.listRooms()); } }
  else io.emit("rooms:updated", gameService.listRooms());
  return result;
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", storage: gameService.storageType, geography: countryCatalogCount(), realtime: "Socket.IO" }));
app.post("/api/players/guest", async (req, res, next) => { const parsed = playerSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Nome de jogador inválido." }); try { const player = gameService.createProfile(parsed.data.name); await gameService.flush(); return res.status(201).json(player); } catch (error) { return next(error); } });
app.get("/api/countries", (_req, res) => res.json({ countries: gameService.countries() }));
app.get("/api/rules", (_req, res) => res.json({ buildings: BUILDINGS, units: UNITS, technologies: TECHNOLOGIES }));
app.get("/api/ranking", (_req, res) => res.json({ ranking: gameService.ranking() }));
app.get("/api/profile", asyncRoute((_req, res, profile) => res.json({ profile })));
app.patch("/api/profile", asyncRoute((req, res, profile) => { const parsed = playerSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Nome de jogador inválido." }); return res.json({ profile: gameService.updateProfile(profile, parsed.data.name) }); }));
app.get("/api/rooms", (_req, res) => res.json({ rooms: gameService.listRooms() }));
app.post("/api/rooms", asyncRoute((req, res, profile) => {
  const schema = z.object({ name: z.string().trim().min(3).max(40), settings: settingsSchema }); const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Dados inválidos para criar a sala." });
  const room = gameService.createRoom(profile, parsed.data); sendRoomUpdate(room.id); return res.status(201).json({ room });
}));
app.post("/api/singleplayer", asyncRoute((req, res, profile) => {
  const schema = z.object({ countryId: z.string().regex(/^\d{3}$/), aiCount: z.number().int().min(1).max(8), difficulty: z.enum(["easy", "normal", "hard"]), settings: settingsSchema.partial().optional() }); const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Configurações de campanha inválidas." });
  const started = gameService.startSinglePlayer(profile, parsed.data); sendRoomUpdate(started.room.id); return res.status(201).json(started);
}));
app.post("/api/rooms/:id/join", withRoomUpdate((req, res, profile) => { const schema = z.object({ password: z.string().max(64).optional() }); const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." }); const room = gameService.joinRoom(profile, routeRoomId(req), parsed.data.password); return res.json({ room }); }));
app.delete("/api/rooms/:id/leave", withRoomUpdate((req, res, profile) => res.json({ room: gameService.leaveRoom(profile, routeRoomId(req)) })));
app.post("/api/rooms/:id/forfeit", withRoomUpdate((req, res, profile) => res.json({ room: gameService.forfeitRoom(profile, routeRoomId(req)) })));
app.patch("/api/rooms/:id/country", withRoomUpdate((req, res, profile) => { const parsed = z.object({ countryId: z.string().regex(/^\d{3}$/) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "País inválido." }); return res.json({ room: gameService.setCountry(profile, routeRoomId(req), parsed.data.countryId) }); }));
app.patch("/api/rooms/:id/ready", withRoomUpdate((req, res, profile) => { const parsed = z.object({ ready: z.boolean() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Estado pronto inválido." }); return res.json({ room: gameService.setReady(profile, routeRoomId(req), parsed.data.ready) }); }));
app.post("/api/rooms/:id/start", withRoomUpdate((req, res, profile) => res.status(200).json(gameService.startRoom(profile, routeRoomId(req)))));
app.get("/api/rooms/:id", asyncRoute((req, res, profile) => { const room = gameService.getRoomFor(profile, routeRoomId(req)); return res.json({ room, game: room.status === "in_progress" ? gameService.gameFor(profile, room.id) : null, messages: gameService.roomChat(room.id) }); }));
app.post("/api/rooms/:id/actions", withRoomUpdate((req, res, profile) => { const parsed = actionSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Ordem inválida ou incompleta." }); return res.json({ game: gameService.act(profile, routeRoomId(req), parsed.data as Action) }); }));
app.post("/api/rooms/:id/chat", withRoomUpdate((req, res, profile) => { const parsed = z.object({ text: z.string().max(300) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Mensagem inválida." }); const roomId = routeRoomId(req); const message = gameService.chat(profile, roomId, parsed.data.text); io.to(`room:${roomId}`).emit("chat:message", message); return res.status(201).json({ message }); }));
app.use(errorHandler);

io.use((socket, next) => { try { const profile = gameService.authenticate(socket.handshake.auth.token as string | undefined); socketProfiles.set(socket.id, profile); connectedSockets.set(profile.id, (connectedSockets.get(profile.id) ?? 0) + 1); next(); } catch { next(new Error("Sessão inválida")); } });
io.on("connection", (socket: Socket) => {
  const profile = socketProfiles.get(socket.id)!;
  socket.on("room:watch", (payload: { roomId?: string }, acknowledge?: (result: { ok: boolean; error?: string }) => void) => { try { const roomId = payload?.roomId?.toUpperCase(); const room = gameService.getRoom(roomId ?? ""); if (!room.playerList?.some(p => p.id === profile.id)) throw new Error("Entre na sala antes de acompanhar."); for (const joined of socket.rooms) if (joined.startsWith("room:")) socket.leave(joined); socket.join(`room:${room.id}`); gameService.markConnected(profile.id, true); socket.emit("lobby:updated", room); if (room.status === "in_progress") socket.emit("game:state", gameService.gameFor(profile, room.id)); socket.emit("chat:history", gameService.roomChat(room.id)); acknowledge?.({ ok: true }); sendRoomUpdate(room.id); } catch (error) { acknowledge?.({ ok: false, error: error instanceof Error ? error.message : "Erro." }); } });
  socket.on("room:unwatch", (payload: { roomId?: string }) => { if (payload?.roomId) socket.leave(`room:${payload.roomId.toUpperCase()}`); });
  socket.on("disconnect", () => { socketProfiles.delete(socket.id); const remaining = Math.max(0, (connectedSockets.get(profile.id) ?? 1) - 1); if (remaining) connectedSockets.set(profile.id, remaining); else { connectedSockets.delete(profile.id); for (const roomId of gameService.markConnected(profile.id, false)) sendRoomUpdate(roomId); } });
});
setInterval(() => { const changedRooms = gameService.advanceTimedTurns(); if (changedRooms.length) void gameService.flush().then(() => changedRooms.forEach(sendRoomUpdate)).catch(error => console.error("Não foi possível salvar turno automático:", error)); }, 1_000).unref();
void gameService.ready.then(() => httpServer.listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`WorldFront API e Socket.IO disponíveis na porta ${port} (${gameService.storageType})`))).catch(error => { console.error("Falha ao inicializar armazenamento:", error); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void gameService.close().finally(() => httpServer.close(() => process.exit(0))); });
function countryCatalogCount(): number { return gameService.countries().length; }
