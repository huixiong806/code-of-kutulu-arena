/**
 * Regression oracle: replay the 20 CodinGame ranked games captured by the
 * visualiser through the JavaScript referee and demand a bit-identical entity
 * stream at every single turn.
 *
 * The bundles are read-only inputs produced by the *Java* referee, so this
 * proves the port (rules, phase order, A*, java.util.Random) end to end.
 *
 *   node tools/verify_replays.mjs [--verbose]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../server/game/referee.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMES = path.resolve(HERE, "../../visualization_tool/data/games");
const CMDS = path.resolve(HERE, "../../visualization_tool/build/replay");
const verbose = process.argv.includes("--verbose");

/** Recorded stdout per seat, with the platform's timeouts made explicit. */
function recordedCommands(id) {
  const dir = path.join(CMDS, String(id));
  if (!fs.existsSync(dir)) return null;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const f = path.join(dir, `p${i}.txt`);
    out.push(fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/) : []);
  }
  return out;
}

const TYPE = {
  EXPLORER: "E",
  WANDERER: "W",
  SLASHER: "S",
  EFFECT_SHELTER: "H",
  EFFECT_PLAN: "P",
  EFFECT_LIGHT: "L",
  EFFECT_YELL: "Y",
};

function parseEntity(line) {
  const f = line.split(" ");
  const t = TYPE[f[0]];
  if (t === "E" || t === "W" || t === "S") return [t, ...f.slice(1, 7).map(Number)];
  if (t === "H") return [t, Number(f[2]), Number(f[3]), Number(f[4])];
  return [t, Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5]), ...(t === "Y" ? [Number(f[6])] : [])];
}

let failures = 0;
let turnsChecked = 0;

const files = fs.readdirSync(GAMES).filter((f) => f.endsWith(".json")).sort();
for (const file of files) {
  const bundle = JSON.parse(fs.readFileSync(path.join(GAMES, file), "utf8"));
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

  let bad = null;
  const cmds = recordedCommands(bundle.id);
  for (let t = 0; t < bundle.turns.length; t++) {
    const turn = bundle.turns[t];
    const actions = turn.plays.map((p) => (p.a && p.a.raw != null ? p.a.raw : null));
    const res = game.step((id) => {
      if (cmds) {
        const line = cmds[id][t];
        return line === undefined || line === "!TIMEOUT" ? null : line;
      }
      return actions[id];
    });
    // The Java trace snapshots *after* the commands were parsed, which is
    // exactly what step() returns as `parsed`.
    const mine = res.parsed.map(parseEntity);
    const theirs = turn.ent;
    turnsChecked++;
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      bad = { t, mine, theirs };
      break;
    }
  }

  if (bad) {
    failures++;
    console.log(`FAIL ${bundle.id} ${bundle.map} @turn ${bad.t}`);
    const n = Math.max(bad.mine.length, bad.theirs.length);
    for (let i = 0; i < n; i++) {
      const a = JSON.stringify(bad.mine[i]);
      const b = JSON.stringify(bad.theirs[i]);
      if (a !== b) console.log(`   #${i}  port=${a}  java=${b}`);
    }
  } else {
    const s = game.standings();
    const order = s.map((p) => p.id);
    const okRank = JSON.stringify(order) === JSON.stringify(bundle.ranking);
    console.log(
      `ok   ${bundle.id} ${String(bundle.map).padEnd(26)} turns=${String(game.turn).padStart(3)}` +
        `  rank=${okRank ? "same" : `DIFF ${order} vs ${bundle.ranking}`}`
    );
    if (!okRank) failures++;
    if (verbose) console.log("      ", s);
  }
}

console.log(`\n${files.length - failures}/${files.length} games match, ${turnsChecked} turns compared`);
process.exit(failures ? 1 : 0);
