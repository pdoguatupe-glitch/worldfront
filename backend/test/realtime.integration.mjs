import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const backend = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = await mkdtemp(join(tmpdir(), "worldfront-realtime-"));
const portServer = createServer();
await new Promise(resolvePort => portServer.listen(0, "127.0.0.1", resolvePort));
const port = portServer.address().port;
await new Promise(resolvePort => portServer.close(resolvePort));
const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
  cwd: backend, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, FRONTEND_ORIGIN: "http://localhost:5173" },
  stdio: "ignore", windowsHide: true,
});
const origin = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const request = async (path, token, body, method = "POST") => {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${value.error ?? response.status}`);
  return value;
};
const nextEvent = (socket, event) => new Promise((resolveEvent, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5_000);
  socket.once(event, value => { clearTimeout(timer); resolveEvent(value); });
});
const sockets = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server exited (${child.exitCode})`);
    try { ready = (await fetch(`${origin}/api/health`)).ok; } catch { await sleep(100); }
  }
  assert.ok(ready, "isolated test server became ready");
  const host = await request("/api/players/guest", undefined, { name: "Realtime Host" });
  const guest = await request("/api/players/guest", undefined, { name: "Realtime Guest" });
  const roomData = await request("/api/rooms", host.sessionToken, { name: "Realtime Test", settings: { maxPlayers: 2, mode: "domination", private: false, duration: 10, speed: 4, fogOfWar: true, diplomacy: true, aiCount: 0 } });
  const roomId = roomData.room.id;
  await request(`/api/rooms/${roomId}/join`, guest.sessionToken, {});
  for (const player of [host, guest]) {
    const socket = io(origin, { auth: { token: player.sessionToken }, transports: ["websocket"] }); sockets.push(socket);
    await new Promise((resolveConnect, rejectConnect) => { socket.once("connect", resolveConnect); socket.once("connect_error", rejectConnect); });
    const ack = await new Promise(resolveAck => socket.emit("room:watch", { roomId }, resolveAck));
    assert.equal(ack.ok, true);
  }
  for (const [player, countryId] of [[host, "076"], [guest, "032"]]) {
    await request(`/api/rooms/${roomId}/country`, player.sessionToken, { countryId }, "PATCH");
    await request(`/api/rooms/${roomId}/ready`, player.sessionToken, { ready: true }, "PATCH");
  }
  const startedUpdates = sockets.map(socket => nextEvent(socket, "game:state"));
  await request(`/api/rooms/${roomId}/start`, host.sessionToken, {});
  const started = await Promise.all(startedUpdates);
  assert.ok(started.every(state => state.status === "active" && state.players.length === 2));

  const guestUpdate = nextEvent(sockets[1], "game:state");
  await request(`/api/rooms/${roomId}/actions`, host.sessionToken, { type: "end_turn" });
  assert.equal((await guestUpdate).activePlayerId, guest.profile.id);
  const chatUpdate = nextEvent(sockets[1], "chat:message");
  await request(`/api/rooms/${roomId}/chat`, host.sessionToken, { text: "Socket.IO em tempo real" });
  assert.equal((await chatUpdate).text, "Socket.IO em tempo real");

  await request(`/api/rooms/${roomId}/forfeit`, guest.sessionToken, {});
  await request(`/api/rooms/${roomId}/forfeit`, host.sessionToken, {});
  console.log("✔ two authenticated players join one room; lobby, turn updates and chat sync over Socket.IO; forfeits close the isolated match");
} finally {
  for (const socket of sockets) socket.disconnect();
  child.kill();
  await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else { child.once("exit", resolveExit); setTimeout(resolveExit, 1_000); } });
  await rm(dataDir, { recursive: true, force: true });
}
