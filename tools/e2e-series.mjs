/**
 * Series test: five games, four bots, placement points must add up.
 *   node tools/e2e-series.mjs [games]
 */
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const GAMES = Number(process.argv[3] || 5);

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

const room = await api("/api/rooms", { name: "系列赛测试", nickname: "裁判", games: GAMES, stepMs: 5000, bankMs: 10000, paceMs: 0 });
for (const [seat, diff] of ["easy", "medium", "hard", "expert"].entries()) {
  await api(`/api/rooms/${room.id}/seat`, { token: room.token, seat, kind: "ai", difficulty: diff });
}
await api(`/api/rooms/${room.id}/start`, { token: room.token });
console.log(`room ${room.id} · ${GAMES} 局`);

let seen = 0;
let last = null;
for (let i = 0; i < 900; i++) {
  await sleep(150);
  const st = await api(`/api/rooms/${room.id}/state?token=${room.token}`);
  const s = st.room.series;
  if (!s) continue;
  last = s;
  if (s.results.length > seen) {
    seen = s.results.length;
    const r = s.results[s.results.length - 1];
    const pts = r.order.map((o) => `${o.seat}:${o.points}`).join(" ");
    const sum = r.order.reduce((a, o) => a + o.points, 0);
    console.log(`  第 ${r.index} 局 ${r.map} ${r.turn}T  ${pts}  (合计 ${sum})`);
    if (Math.abs(sum - 10) > 1e-6) throw new Error(`points do not sum to 10: ${sum}`);
  }
  if (s.done) break;
  if (st.room.state === "finished") break;
}

if (!last || !last.done) throw new Error("series did not finish");
console.log("最终累计：");
for (const r of last.rows) console.log(`  ${r.place}. ${r.name}  ${r.points} 分  (胜 ${r.wins})`);
const total = last.rows.reduce((a, r) => a + r.points, 0);
console.log(`总积分 ${total} / 期望 ${GAMES * 10}`);
if (Math.abs(total - GAMES * 10) > 1e-6) throw new Error("series total is wrong");

const replays = await api("/api/replays");
const mine = replays.replays.filter((r) => r.room === room.id);
console.log(`归档录像 ${mine.length} 条（期望 ${GAMES}）`);
if (mine.length !== GAMES) throw new Error("missing replays");
console.log("ok");
