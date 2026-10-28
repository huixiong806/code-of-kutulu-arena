/**
 * 候选池两两胜率矩阵：每局随机抽 4 个，统计每个 pair 谁排前面。
 *   node tools/pairmatrix.mjs 72 clawd orangebird casper wide turbo learned3
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Game } from "../server/game/referee.js";
import { BotProcess } from "../server/game/bots.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "../bots");
const args = process.argv.slice(2);
const games = Number(args.shift() || 72);
const names = args;

const pool = names.map((n) => ({ name: n, exe: path.join(DIR, `${n}.exe`) }));
for (const b of pool) if (!fs.existsSync(b.exe)) throw new Error(`missing ${b.exe}`);

const pair = Object.fromEntries(names.map((a) => [a, Object.fromEntries(names.map((b) => [b, { w: 0, n: 0 }]))]));
const places = Object.fromEntries(names.map((n) => [n, []]));
const seed = () => BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);

for (let g = 0; g < games; g++) {
  const pick = [...pool].sort(() => Math.random() - 0.5).slice(0, 4);
  const game = new Game({ seed: seed() });
  const procs = pick.map((c) => new BotProcess(c.exe, { timeoutMs: 4000 }).start());
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
  order.forEach((p, idx) => (place[pick[p.id].name] = idx + 1));
  for (const n of names) places[n].push(place[n]);
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const a = pick[i].name;
      const b = pick[j].name;
      pair[a][b].n++;
      pair[b][a].n++;
      if (place[a] < place[b]) pair[a][b].w++;
      else pair[b][a].w++;
    }
  }
  if ((g + 1) % 12 === 0) process.stdout.write(`  ${g + 1}/${games}\n`);
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const ordered = [...names].sort((x, y) => avg(places[x]) - avg(places[y]));
console.log(`\n${games} 局平均名次：`);
for (const n of ordered) console.log(`  ${n.padEnd(12)} ${avg(places[n]).toFixed(2)}  (${places[n].length} 局)`);

console.log(`\n两两胜率（行 对 列，样本在上三角括号里）：`);
console.log("  " + "".padEnd(11) + ordered.map((n) => n.padStart(12)).join(""));
for (const a of ordered) {
  const cells = ordered.map((b) => {
    if (a === b) return "—";
    const p = pair[a][b];
    return `${((p.w / Math.max(1, p.n)) * 100).toFixed(0)}% (${p.n})`;
  });
  console.log("  " + a.padEnd(11) + cells.map((c) => c.padStart(12)).join(""));
}
