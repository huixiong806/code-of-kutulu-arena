/** 对照竞技场地图池与平台（Legend）地图池。 */
import { ALL_MAPS } from "../server/game/maps.js";
import { PLAYABLE_MAPS } from "../server/game/referee.js";

// MazeFactory.bronzeMaps：Legend 实际会抽到的 16 张
const BRONZE = [
  "Four of a kind",
  "Hypersonic",
  "Origin of symmetry",
  "Shelter me",
  "Slasher's hell",
  "Typhoon",
  "Oasis",
  "Cross",
  "Shelter in Peril",
  "Corridors",
  "Roommates",
  "Pac man",
  "The challenge from beyond",
  "Cog",
  "Hill climbing",
  "Pixelated",
];

const arena = PLAYABLE_MAPS.map((m) => m.name);
console.log(`ALL_MAPS（抽出来的源文件）: ${ALL_MAPS.length} 张`);
console.log(`竞技场实际会抽: ${arena.length} 张`);
console.log(`平台 bronze 池: ${BRONZE.length} 张`);

const extra = arena.filter((n) => !BRONZE.includes(n));
const missing = BRONZE.filter((n) => !arena.includes(n));
console.log("竞技场多出来的:", extra.length ? extra : "（无）");
console.log("平台有但竞技场没有:", missing.length ? missing : "（无）");

for (const m of PLAYABLE_MAPS) {
  const starts = m.rows.join("").split("S").length - 1;
  if (starts !== 4) console.log(`  !! ${m.name} 只有 ${starts} 个出生点`);
}
process.exit(extra.length || missing.length ? 1 : 0);
