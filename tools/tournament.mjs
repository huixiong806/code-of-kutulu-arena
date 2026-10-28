/**
 * 候选池排名赛：每局随机抽 4 个 bot，统计平均名次。
 *   node tools/tournament.mjs 48
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Game } from "../server/game/referee.js";
import { BotProcess } from "../server/game/bots.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOTS_DIR = path.resolve(HERE, "../bots");
const games = Number(process.argv[2] || 48);

const pool = fs
  .readdirSync(BOTS_DIR)
  .filter((f) => f.endsWith(".exe"))
  .map((f) => ({ name: f.replace(/\.exe$/, ""), exe: path.join(BOTS_DIR, f) }));

if (pool.length < 4) throw new Error("need at least 4 bots in arena/bots");
console.log(`候选 ${pool.length}: ${pool.map((b) => b.name).join(", ")}\n`);

const stat = Object.fromEntries(pool.map((b) => [b.name, { places: [], wins: 0, games: 0, fails: 0 }]));
const seed = () => BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);

for (let g = 0; g < games; g++) {
  // random four distinct contestants
  const pick = [...pool].sort(() => Math.random() - 0.5).slice(0, 4);
  const game = new Game({ seed: seed() });
  const bots = pick.map((c) => new BotProcess(c.exe, { timeoutMs: 4000 }).start());
  for (const b of bots) b.writeTurn(game.initInput());

  let turns = 0;
  let failed = false;
  while (game.turn <= 200) {
    const inputs = bots.map((_, i) => game.inputFor(i));
    const outs = await Promise.all(bots.map((b, i) => b.ask(inputs[i])));
    if (outs.some((o) => o == null)) {
      failed = true;
      break;
    }
    game.step((id) => outs[id]);
    turns++;
    if (game.active().length === 0) break;
  }
  for (const b of bots) b.stop();
  if (failed) {
    for (const c of pick) stat[c.name].fails++;
    continue;
  }

  const order = game.standings();
  order.forEach((p, idx) => {
    const c = pick[p.id];
    stat[c.name].places.push(idx + 1);
    stat[c.name].games++;
    if (idx === 0) stat[c.name].wins++;
  });
  process.stdout.write(`  ${String(g + 1).padStart(2)}/${games} ${game.map.name.padEnd(24)} ${String(turns).padStart(3)}T  ${order.map((p, i) => `${i + 1}.${pick[p.id].name}`).join(" ")}\n`);
}

console.log("\n排名（平均名次，越小越强）：");
const rows = Object.entries(stat)
  .map(([name, s]) => ({
    name,
    avg: s.places.length ? s.places.reduce((a, b) => a + b, 0) / s.places.length : 99,
    win: s.games ? (s.wins / s.games) * 100 : 0,
    n: s.games,
    fails: s.fails,
  }))
  .sort((a, b) => a.avg - b.avg);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(12)} 名次 ${r.avg.toFixed(2)}  胜率 ${r.win.toFixed(0).padStart(3)}%  ${r.n} 局${r.fails ? `  (失败 ${r.fails})` : ""}`);
}
