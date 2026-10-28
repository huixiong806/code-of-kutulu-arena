/**
 * 四个难度同场竞技：座位轮转，保证每个 bot 都坐过 0–3 号位。
 *   node tools/ladder.mjs 16
 */
import { Game } from "../server/game/referee.js";
import { BotProcess } from "../server/game/bots.js";

const games = Number(process.argv[2] || 16);
const BOTS = ["easy", "medium", "hard", "expert"];
const stats = Object.fromEntries(BOTS.map((k) => [k, { places: [], wins: 0, sanity: 0 }]));

const seed = () => BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);

for (let g = 0; g < games; g++) {
  const rot = g % 4;
  const lineup = BOTS.map((_, i) => BOTS[(i + rot) % 4]); // 每个 bot 轮流坐不同座位
  const game = new Game({ seed: seed() });
  const bots = lineup.map((k) => new BotProcess(k, { timeoutMs: 3000 }).start());
  for (const b of bots) b.writeTurn(game.initInput());

  let turns = 0;
  while (game.turn <= 200) {
    const inputs = bots.map((_, i) => game.inputFor(i));
    const outs = await Promise.all(bots.map((b, i) => b.ask(inputs[i])));
    if (outs.some((o) => o == null)) break;
    game.step((id) => outs[id]);
    turns++;
    if (game.active().length === 0) break;
  }
  for (const b of bots) b.stop();

  const order = game.standings();
  order.forEach((p, idx) => {
    const key = lineup[p.id];
    stats[key].places.push(idx + 1);
    stats[key].sanity += p.alive ? p.sanity : 0;
    if (idx === 0) stats[key].wins++;
  });
  console.log(
    `  ${String(g + 1).padStart(2)}. ${game.map.name.padEnd(26)} ${String(turns).padStart(3)}T  ` +
      order.map((p, i) => `${i + 1}.${lineup[p.id]}`).join("  ")
  );
}

console.log(`\n${games} 局平均名次：`);
const rows = BOTS.map((k) => {
  const s = stats[k];
  return {
    key: k,
    avg: s.places.reduce((a, b) => a + b, 0) / s.places.length,
    win: (s.wins / games) * 100,
    sanity: s.sanity / games,
  };
}).sort((a, b) => a.avg - b.avg);
for (const r of rows) {
  console.log(`  ${r.key.padEnd(7)} 名次 ${r.avg.toFixed(2)}  胜率 ${r.win.toFixed(0).padStart(3)}%  平均理智 ${r.sanity.toFixed(0)}`);
}
