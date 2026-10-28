/**
 * 指定 4 个 bot 打循环赛，座位轮转，输出两两胜率矩阵。
 *   node tools/roundrobin.mjs clawd orangebird casper wide 40
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Game } from "../server/game/referee.js";
import { BotProcess } from "../server/game/bots.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "../bots");
const args = process.argv.slice(2);
const games = Number(args.pop() || 40);
const names = args;
if (names.length !== 4) throw new Error("give exactly 4 bot names");

const bots = names.map((n) => ({ name: n, exe: path.join(DIR, `${n}.exe`) }));
for (const b of bots) if (!fs.existsSync(b.exe)) throw new Error(`missing ${b.exe}`);

const pair = Object.fromEntries(names.map((a) => [a, Object.fromEntries(names.map((b) => [b, { w: 0, n: 0 }]))]));
const places = Object.fromEntries(names.map((n) => [n, []]));
const seed = () => BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);

for (let g = 0; g < games; g++) {
  const rot = g % 4;
  const lineup = [0, 1, 2, 3].map((i) => bots[(i + rot) % 4]);
  const game = new Game({ seed: seed() });
  const procs = lineup.map((c) => new BotProcess(c.exe, { timeoutMs: 4000 }).start());
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
  if (!ok) continue;

  const order = game.standings();
  const place = {};
  order.forEach((p, idx) => (place[lineup[p.id].name] = idx + 1));
  for (const n of names) places[n].push(place[n]);
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const a = lineup[i].name;
      const b = lineup[j].name;
      pair[a][b].n++;
      pair[b][a].n++;
      if (place[a] < place[b]) pair[a][b].w++;
      else pair[b][a].w++;
    }
  }
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log(`\n${games} 局，平均名次：`);
for (const n of [...names].sort((x, y) => avg(places[x]) - avg(places[y]))) {
  console.log(`  ${n.padEnd(12)} ${avg(places[n]).toFixed(2)}`);
}
console.log(`\n两两胜率（行 对 列）：`);
console.log("             " + names.map((n) => n.padStart(11)).join(""));
for (const a of names) {
  const cells = names.map((b) => (a === b ? "—" : `${((pair[a][b].w / Math.max(1, pair[a][b].n)) * 100).toFixed(0)}%`));
  console.log(a.padEnd(13) + cells.map((c) => c.padStart(11)).join(""));
}
