/**
 * 五档 AI 大规模混战统计。
 *
 *   node tools/ladderstats.mjs 1000 4
 *
 * 每局从 5 个档位里轮换地去掉一个（保证每档出场次数相同），随机排座位，
 * 统计每档的 1 位率 / 4 位率 / 平均名次，写 data/ladder.json。
 *
 * 并行 N 路只是为了让 1000 局在可接受时间内跑完；机器人用的是墙钟预算，
 * 并行会轻微压缩单局算力，但四家同时受影响，相对强弱不受影响。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Game } from "../server/game/referee.js";
import { BotProcess, availableBots } from "../server/game/bots.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARENA = path.resolve(HERE, "..");
const games = Number(process.argv[2] || 1000);
const workers = Math.max(1, Number(process.argv[3] || 4));

const bots = availableBots().filter((b) => b.available);
if (bots.length < 5) throw new Error(`need 5 bots, got ${bots.length}`);

const stat = Object.fromEntries(
  bots.map((b) => [b.key, { key: b.key, label: b.label, file: b.file, desc: b.desc, played: 0, first: 0, second: 0, third: 0, fourth: 0, placeSum: 0 }])
);
let done = 0;
let failed = 0;
const t0 = Date.now();

const seed = () => BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);

async function playOne(index) {
  // 轮换去掉一档，保证每个 bot 出场次数一样
  const skip = index % bots.length;
  const lineup = bots.filter((_, i) => i !== skip).map((b) => b);
  for (let i = lineup.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lineup[i], lineup[j]] = [lineup[j], lineup[i]];
  }

  const game = new Game({ seed: seed() });
  const procs = lineup.map((c) => new BotProcess(c.path, { timeoutMs: 5000 }).start());
  for (const p of procs) p.writeTurn(game.initInput());

  let ok = true;
  while (game.turn <= 200) {
    const inputs = procs.map((_, i) => game.inputFor(i));
    const outs = await Promise.all(procs.map((p, i) => p.ask(inputs[i])));
    if (outs.some((o) => o == null)) {
      ok = false;
      break;
    }
    game.step((id) => outs[id]);
    if (game.active().length === 0) break;
  }
  for (const p of procs) p.stop();
  if (!ok) {
    failed++;
    return;
  }

  game.standings().forEach((p, idx) => {
    const s = stat[lineup[p.id].key];
    s.played++;
    s.placeSum += idx + 1;
    if (idx === 0) s.first++;
    else if (idx === 1) s.second++;
    else if (idx === 2) s.third++;
    else s.fourth++;
  });
}

async function worker(w) {
  for (let i = w; i < games; i += workers) {
    await playOne(i);
    done++;
    if (done % 50 === 0) {
      const secs = (Date.now() - t0) / 1000;
      const eta = (secs / done) * (games - done);
      process.stdout.write(`  ${done}/${games}  已用 ${(secs / 60).toFixed(1)}min  预计剩余 ${(eta / 60).toFixed(1)}min\n`);
    }
  }
}

await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));

const rows = Object.values(stat)
  .map((s) => ({
    ...s,
    firstRate: s.played ? s.first / s.played : 0,
    fourthRate: s.played ? s.fourth / s.played : 0,
    avgPlace: s.played ? s.placeSum / s.played : 0,
  }))
  .sort((a, b) => b.firstRate - a.firstRate || a.avgPlace - b.avgPlace);

const out = {
  generatedAt: new Date().toISOString(),
  games,
  finished: games - failed,
  failed,
  workers,
  seconds: Math.round((Date.now() - t0) / 1000),
  rows: rows.map((r) => ({
    key: r.key,
    label: r.label,
    file: r.file,
    desc: r.desc,
    played: r.played,
    first: r.first,
    fourth: r.fourth,
    firstRate: Math.round(r.firstRate * 1000) / 10,
    fourthRate: Math.round(r.fourthRate * 1000) / 10,
    avgPlace: Math.round(r.avgPlace * 100) / 100,
  })),
};
fs.mkdirSync(path.join(ARENA, "data"), { recursive: true });
fs.writeFileSync(path.join(ARENA, "data/ladder.json"), JSON.stringify(out, null, 1));

console.log("\n档位      出场   1位率   4位率   平均名次");
for (const r of out.rows) {
  console.log(
    `${r.label.padEnd(6)} ${String(r.played).padStart(6)}  ${String(r.firstRate).padStart(6)}%  ${String(r.fourthRate).padStart(6)}%   ${r.avgPlace.toFixed(2)}`
  );
}
console.log(`\n${out.finished} 局有效，${failed} 局失败，用时 ${(out.seconds / 60).toFixed(1)} 分钟`);
