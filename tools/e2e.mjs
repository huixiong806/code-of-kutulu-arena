/**
 * End-to-end check of the arena server, no browser involved.
 *
 *   node tools/e2e.mjs [baseUrl]
 *
 * Creates a room, fills all four seats with AI, starts it, waits for the game
 * to finish and verifies that a replay bundle was archived.
 */
const BASE = process.argv[2] || "http://127.0.0.1:8787";

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

const t0 = Date.now();
const created = await api("/api/rooms", { name: "E2E 全 AI", nickname: "裁判", stepMs: 5000, bankMs: 10000, paceMs: 0 });
const token = created.token;
console.log("room", created.id, "seat", created.seat);

const diffs = ["easy", "medium", "hard", "expert"];
for (let i = 0; i < 4; i++) {
  await api(`/api/rooms/${created.id}/seat`, { token, seat: i, kind: "ai", difficulty: diffs[i] });
}
await api(`/api/rooms/${created.id}/start`, { token });
console.log("started; waiting for the bots ...");

let lastTurn = -1;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 120));
  const st = await api(`/api/rooms/${created.id}/state`);
  const snap = st.snapshot;
  if (snap && snap.turn !== lastTurn) {
    lastTurn = snap.turn;
    if (lastTurn % 25 === 0) process.stdout.write(`  T${lastTurn}\n`);
  }
  if (st.room.state === "finished") break;
}

const st = await api(`/api/rooms/${created.id}/state`);
console.log("state:", st.room.state, "turn:", st.snapshot?.turn, "map:", st.snapshot?.map);
console.log("standings:", st.snapshot?.standings?.map((p) => `p${p.id}:${p.alive ? p.sanity : "out@T" + p.score}`).join(" "));

const list = await api("/api/replays");
const mine = list.replays.find((r) => r.room === created.id);
if (!mine) {
  console.log("!! replay not archived");
  process.exit(1);
}
const bundle = await api(`/api/replays/${mine.id}`);
console.log(`replay ${bundle.id}: ${bundle.turns.length} turns, map=${bundle.map}, seats=${bundle.meta.seats.map((s) => s.difficulty).join(",")}`);
console.log(`ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
