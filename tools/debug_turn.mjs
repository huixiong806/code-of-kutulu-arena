/**
 * Print the divergence context for one recorded game.
 *   node tools/debug_turn.mjs 909789256 37
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../server/game/referee.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMES = path.resolve(HERE, "../../visualization_tool/data/games");

const id = process.argv[2];
const stop = Number(process.argv[3] || 999);
const bundle = JSON.parse(fs.readFileSync(path.join(GAMES, `${id}.json`), "utf8"));
const game = new Game({
  seed: bundle.seed,
  mapName: bundle.map,
  params: {
    lonely: bundle.params[0],
    group: bundle.params[1],
    spawnTime: bundle.params[2],
    life: bundle.params[3],
  },
});

const TYPE = { EXPLORER: "E", WANDERER: "W", SLASHER: "S", EFFECT_SHELTER: "H", EFFECT_PLAN: "P", EFFECT_LIGHT: "L", EFFECT_YELL: "Y" };
const parse = (line) => {
  const f = line.split(" ");
  const t = TYPE[f[0]];
  if (t === "E" || t === "W" || t === "S") return [t, ...f.slice(1, 7).map(Number)];
  if (t === "H") return [t, Number(f[2]), Number(f[3]), Number(f[4])];
  return [t, Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5]), ...(t === "Y" ? [Number(f[6])] : [])];
};

for (let t = 0; t < Math.min(stop, bundle.turns.length - 1); t++) {
  const turn = bundle.turns[t];
  const actions = turn.plays.map((p) => (p.a && p.a.raw != null ? p.a.raw : null));
  const before = game.minions.map((m) => ({ ...m, targetId: m.target ? m.target.id : -1 }));
  game.step((pid) => actions[pid]);
  const mine = game.snapshot().entities.map(parse);
  const theirs = bundle.turns[t + 1] ? bundle.turns[t + 1].ent : [];
  const same = JSON.stringify(mine) === JSON.stringify(theirs);
  if (!same) {
    console.log(`turn ${t} -> ${t + 1} MISMATCH`);
    console.log("  actions:", actions.join(" | "));
    console.log("  players before:", turn.plays.map((p) => `p${p.s[0]}(${p.s[1]},${p.s[2]})`).join(" "));
    for (const m of before) {
      if (m.kind !== "S") continue;
      console.log(
        `  slasher#${m.id} before: pos(${m.x},${m.y}) state=${m.state} cd=${m.stunCountdown}/${m.spawnCountdown}/${m.lifeTimeCountdown} ` +
          `target=${m.targetId} prep=${m.prepTarget ? `${m.prepTarget.x},${m.prepTarget.y}` : "-"}`
      );
    }
    const n = Math.max(mine.length, theirs.length);
    for (let i = 0; i < n; i++) {
      const a = JSON.stringify(mine[i]);
      const b = JSON.stringify(theirs[i]);
      if (a !== b) console.log(`    #${i} port=${a} java=${b}`);
    }
    break;
  }
}
