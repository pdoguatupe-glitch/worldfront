import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RoomSettings } from "@worldfront/shared";
import { GameService } from "../src/game/gameService.js";
import { countryById, countryCatalog } from "../src/game/countryCatalog.js";

function withService<T>(run: (service: GameService) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "worldfront-test-"));
  try { return run(new GameService(join(dir, "state.json"))); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const settings: RoomSettings = { maxPlayers: 4, mode: "domination", private: false, duration: 30, speed: 4, fogOfWar: true, diplomacy: true, aiCount: 0 };

test("catalog loads real countries and neighboring boundaries", () => {
  assert.ok(countryCatalog.length > 160);
  const brazil = countryById.get("076");
  assert.equal(brazil?.code, "BRA");
  assert.ok((brazil?.neighbors.length ?? 0) > 0);
  const paraguay = countryById.get("600");
  assert.ok(brazil?.neighbors.includes("600"));
  assert.ok(paraguay?.neighbors.includes("076"));
});

test("persistent profiles create rooms, prevent country collisions and start a shared lobby", () => withService(service => {
  const host = service.createProfile("Host One"); const guest = service.createProfile("Player Two");
  const room = service.createRoom(host.profile, { name: "Test Front", settings });
  service.joinRoom(guest.profile, room.id);
  service.setCountry(host.profile, room.id, "076");
  assert.throws(() => service.setCountry(guest.profile, room.id, "076"), /já foi escolhido/);
  service.setCountry(guest.profile, room.id, "032");
  service.setReady(host.profile, room.id, true); service.setReady(guest.profile, room.id, true);
  const started = service.startRoom(host.profile, room.id);
  assert.equal(started.game.players.length, 2);
  assert.equal(started.game.players[0]?.countryId, "076");
  assert.equal(started.room.status, "in_progress");
  assert.throws(() => service.startRoom(guest.profile, room.id), /aguardando/);
  const reloaded = new GameService((service as unknown as { storagePath: string }).storagePath);
  assert.equal(reloaded.getRoom(room.id).status, "in_progress");
}));

test("server charges authoritative construction costs and advances economic cycles", () => withService(service => {
  const guest = service.createProfile("Economist");
  const { room, game } = service.startSinglePlayer(guest.profile, { countryId: "076", aiCount: 1, difficulty: "easy", settings: { ...settings, mode: "economic" } });
  const start = game.nations["076"]!; const originalMoney = start.resources.money;
  const build = service.act(guest.profile, room.id, { type: "build", building: "farm", countryId: "076" });
  assert.equal(build.nations["076"]!.resources.money, originalMoney - 160);
  assert.equal(build.nations["076"]!.construction[0]?.type, "farm");
  service.act(guest.profile, room.id, { type: "end_turn" });
  const next = service.gameFor(guest.profile, room.id);
  assert.equal(next.turn, 2);
  assert.equal(next.nations["076"]!.buildings.farm, 2);
  assert.notEqual(next.nations["076"]!.gdp, start.gdp);
}));

test("combat requires a border and war; combat and conquest state stay on server", () => withService(service => {
  const guest = service.createProfile("Strategist"); const { room, game } = service.startSinglePlayer(guest.profile, { countryId: "076", aiCount: 1, difficulty: "easy" });
  const brazil = countryById.get("076")!; const target = brazil.neighbors[0]!;
  assert.throws(() => service.act(guest.profile, room.id, { type: "attack", fromCountry: "076", targetCountry: target }), /Declare guerra/);
  const war = service.act(guest.profile, room.id, { type: "declare_war", targetCountry: target, countryId: "076" });
  assert.equal(war.relations.find(r => r.countryId === "076" && r.targetId === target)?.status, "war");
  const result = service.act(guest.profile, room.id, { type: "attack", fromCountry: "076", targetCountry: target });
  assert.ok(["combat", "conquest"].includes(result.events[0]!.type));
  assert.ok(Object.values(result.nations["076"]!.units).reduce((a,b)=>a+b,0) <= Object.values(game.nations["076"]!.units).reduce((a,b)=>a+b,0));
}));

test("diplomatic proposals require recipient approval; technology validates prerequisites", () => withService(service => {
  const host = service.createProfile("Diplomat One"); const guest = service.createProfile("Diplomat Two");
  const room = service.createRoom(host.profile, { name: "Treaty Test", settings }); service.joinRoom(guest.profile, room.id);
  service.setCountry(host.profile, room.id, "076"); service.setCountry(guest.profile, room.id, "032");
  service.setReady(host.profile, room.id, true); service.setReady(guest.profile, room.id, true);
  service.startRoom(host.profile, room.id);
  assert.throws(() => service.act(host.profile, room.id, { type: "research", technology: "armored_warfare" }), /pré-requisitos/);
  let state = service.act(host.profile, room.id, { type: "offer", targetPlayerId: guest.profile.id, treaty: "alliance" });
  assert.equal(state.offers.length, 1);
  service.act(host.profile, room.id, { type: "end_turn" });
  state = service.act(guest.profile, room.id, { type: "respond_offer", offerIndex: 0, accept: true });
  assert.equal(state.relations.find(r => r.countryId === "076" && r.targetId === "032")?.status, "alliance");
}));

test("secret changes are server-applied without publishing an event", () => withService(service => {
  const player = service.createProfile("Comandante"); const { room, game } = service.startSinglePlayer(player.profile, { countryId: "076", aiCount: 1, difficulty: "easy" });
  const originalEvents = game.events.length;
  const after = service.act(player.profile, room.id, { type: "black_ops", countryId: "076", changes: { money: 99999, infiniteTroops: true, godMode: true } });
  assert.equal(after.nations["076"]!.resources.money, 99999);
  assert.equal(after.events.length, originalEvents);
  assert.equal(after.nations["076"]!.secretModifiers?.godMode, true);
}));

test("solo campaign creates the requested number of AI nations and forfeits are recorded", () => withService(service => {
  const player = service.createProfile("Campaigner");
  const { room, game } = service.startSinglePlayer(player.profile, { countryId: "076", aiCount: 7, difficulty: "easy" });
  assert.equal(game.players.length, 8);
  assert.equal(room.maxPlayers, 8);
  service.forfeitRoom(player.profile, room.id);
  assert.equal(player.profile.matches, 1);
  assert.equal(player.profile.losses, 1);
  assert.equal(service.getRoom(room.id).status, "finished");
}));

test("time victory waits until the configured turn limit", () => withService(service => {
  const player = service.createProfile("Time Strategist");
  const { room } = service.startSinglePlayer(player.profile, { countryId: "076", aiCount: 1, difficulty: "easy", settings: { ...settings, mode: "time", duration: 3 } });
  service.act(player.profile, room.id, { type: "end_turn" });
  assert.equal(service.gameFor(player.profile, room.id).status, "active");
  service.act(player.profile, room.id, { type: "end_turn" });
  const finished = service.gameFor(player.profile, room.id);
  assert.equal(finished.turn, 3);
  assert.equal(finished.status, "finished");
  assert.ok(finished.winnerId);
}));
