/**
 * Two-human turn gate test.
 *
 *   node tools/e2e-multi.mjs [baseUrl]
 *
 * Verifies that a turn only resolves once *every* seat has acted, that a seat
 * can revise its action, and that stale turns are rejected.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await api("/api/rooms", { name: "双人测试", nickname: "甲", stepMs: 5000, bankMs: 10000, paceMs: 0 });
const b = await api(`/api/rooms/${a.id}/join`, { nickname: "乙" });
console.log("room", a.id, "A seat", a.seat, "B seat", b.seat);

for (const seat of [2, 3]) {
  await api(`/api/rooms/${a.id}/seat`, { token: a.token, seat, kind: "ai", difficulty: seat === 2 ? "medium" : "hard" });
}
await api(`/api/rooms/${a.id}/start`, { token: a.token });
await sleep(200);

let st = await api(`/api/rooms/${a.id}/state?token=${a.token}`);
console.log("turn", st.snapshot.turn, "pending", st.snapshot.pending, "isMyTurn", st.snapshot.isMyTurn);

await api(`/api/rooms/${a.id}/act`, { token: a.token, seat: a.seat, turn: st.snapshot.turn, action: "WAIT" });
await sleep(250);
let st2 = await api(`/api/rooms/${a.id}/state?token=${a.token}`);
console.log("after A acts -> turn", st2.snapshot.turn, "pending", st2.snapshot.pending);
if (st2.snapshot.turn !== 0) throw new Error("turn advanced before B acted");

// A may revise its action while the turn is still open
await api(`/api/rooms/${a.id}/act`, { token: a.token, seat: a.seat, turn: 0, action: "PLAN" });
st2 = await api(`/api/rooms/${a.id}/state?token=${a.token}`);
if (st2.snapshot.lastAction !== "PLAN") throw new Error("revision not applied");
console.log("A revised to", st2.snapshot.lastAction);

const stale = await fetch(`${BASE}/api/rooms/${a.id}/act`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: b.token, seat: b.seat, turn: 99, action: "WAIT" }),
});
console.log("stale turn rejected:", stale.status === 400);

await api(`/api/rooms/${a.id}/act`, { token: b.token, seat: b.seat, turn: 0, action: "MOVE 8 8" });
await sleep(400);
const st3 = await api(`/api/rooms/${a.id}/state?token=${a.token}`);
console.log("after B acts -> turn", st3.snapshot.turn, "pending", st3.snapshot.pending);
if (st3.snapshot.turn !== 1) throw new Error("turn did not advance");

const p = st3.snapshot.players;
console.log("players:", p.map((x) => `p${x.id}@(${x.x},${x.y}):${x.sanity}`).join(" "));
console.log("ok");
