/**
 * Full-game soak test: four real C++ bots, one JS referee.
 *
 *   node tools/soak.mjs --games 4
 *
 * Prints per-game results and per-turn latency, and fails if any bot crashes
 * or stops answering.
 */
import { Game } from "../server/game/referee.js";
import { BotProcess, DIFFICULTIES } from "../server/game/bots.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const games = Number(flag("--games", "3"));
const lineup = flag("--lineup", "easy,medium,hard,expert").split(",");

function seed() {
  return BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);
}

let totalTurns = 0;
let maxMs = 0;
let failures = 0;

for (let g = 0; g < games; g++) {
  const game = new Game({ seed: seed(), mapName: null });
  const bots = lineup.map((key) => new BotProcess(key, { timeoutMs: 2000 }).start());
  const init = game.initInput();

  for (const bot of bots) bot.writeTurn(init);

  const t0 = Date.now();
  let turnCount = 0;
  while (!game.finished && game.turn <= 200) {
    const inputs = bots.map((_, i) => game.inputFor(i));
    const started = Date.now();
    const outs = await Promise.all(bots.map((bot, i) => bot.ask(inputs[i])));
    const dt = Date.now() - started;
    if (dt > maxMs) maxMs = dt;
    const dead = outs.filter((o) => o == null).length;
    if (dead) {
      failures++;
      console.log(`  !! ${dead} bot(s) stopped answering at turn ${game.turn}`);
      break;
    }
    game.step((id) => outs[id]);
    turnCount++;
  }
  totalTurns += turnCount;

  const stand = game.standings();
  const label = stand
    .map((p, i) => `${i + 1}. p${p.id}(${lineup[p.id]}) ${p.alive ? p.sanity : "dead"}${p.alive ? "" : `@${p.score}`}`)
    .join("  ");
  console.log(
    `game ${g + 1}: ${game.map.name.padEnd(26)} turns=${String(turnCount).padStart(3)} ` +
      `${Date.now() - t0}ms  ${label}`
  );
  for (const bot of bots) {
    const err = bot.errors.find((e) => /error|exception|assert/i.test(e));
    if (err) console.log(`   stderr[${bot.key}]: ${err.slice(0, 160)}`);
    bot.stop();
  }
}

console.log(
  `\n${games} games, ${totalTurns} turns, slowest turn ${maxMs}ms, failures=${failures}`
);
process.exit(failures ? 1 : 0);
