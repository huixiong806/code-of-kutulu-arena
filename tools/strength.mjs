/**
 * Strength check: does the "expert" seat actually beat the baseline?
 *
 *   node tools/strength.mjs expert easy 20
 *
 * Rotates the target seat every game to cancel seat bias, then reports the
 * average placement and head-to-head win rate against the baseline bot.
 * Also asserts that no bot left extra output lines behind (protocol desync).
 */
import { Game } from "../server/game/referee.js";
import { BotProcess } from "../server/game/bots.js";

const target = process.argv[2] || "expert";
const baseline = process.argv[3] || "easy";
const games = Number(process.argv[4] || 12);

function seed() {
  return BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);
}

const tally = { target: { places: [], wins: 0 }, base: { places: [], wins: 0 } };
let desync = 0;
let slowest = 0;

for (let g = 0; g < games; g++) {
  const seat = g % 4;
  const lineup = [0, 1, 2, 3].map((s) => (s === seat ? target : baseline));
  const game = new Game({ seed: seed() });
  const bots = lineup.map((k) => new BotProcess(k, { timeoutMs: 3000 }).start());
  for (const b of bots) b.writeTurn(game.initInput());

  let turns = 0;
  while (game.turn <= 200) {
    const inputs = bots.map((_, i) => game.inputFor(i));
    const t0 = Date.now();
    const outs = await Promise.all(bots.map((b, i) => b.ask(inputs[i])));
    slowest = Math.max(slowest, Date.now() - t0);
    if (outs.some((o) => o == null)) break;
    game.step((id) => outs[id]);
    turns++;
    if (game.active().length === 0) break;
  }

  // any bot still holding buffered lines = it printed more than one line per turn
  for (const b of bots) {
    if (b.lines.length) {
      desync++;
      console.log(`  !! ${b.key} left ${b.lines.length} extra line(s): ${JSON.stringify(b.lines.slice(0, 2))}`);
    }
    b.stop();
  }

  const order = game.standings();
  const place = order.findIndex((p) => p.id === seat) + 1;
  tally.target.places.push(place);
  if (place === 1) tally.target.wins++;
  for (let s = 0; s < 4; s++) {
    if (s === seat) continue;
    const p = order.findIndex((x) => x.id === s) + 1;
    tally.base.places.push(p);
    if (p === 1) tally.base.wins++;
  }
  const tag = `${target}@seat${seat} vs 3x${baseline}`;
  console.log(`  ${tag.padEnd(28)} ${turns}T  ${game.map.name.padEnd(24)} 名次 ${place}`);
}

const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
console.log(`\n${games} 局，最慢一手 ${slowest}ms，协议错位 ${desync} 次`);
console.log(
  `  ${target.padEnd(8)} 平均名次 ${avg(tally.target.places)} · 胜率 ${((tally.target.wins / games) * 100).toFixed(0)}%`
);
console.log(
  `  ${baseline.padEnd(8)} 平均名次 ${avg(tally.base.places)} · 胜率 ${((tally.base.wins / (games * 3)) * 100).toFixed(0)}%`
);
