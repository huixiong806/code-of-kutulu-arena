/**
 * Rebuild data/replays/index.json from the archived bundles.
 *   node tools/reindex-replays.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "../data/replays");

const entries = [];
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith(".json") || f === "index.json") continue;
  const b = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  entries.push({
    id: b.id,
    room: String(b.id).split("-")[0],
    name: b.name,
    map: b.map,
    ended: b.meta?.ended || null,
    turns: b.turns.length,
    seats: b.meta?.seats || [],
    winner: b.ranking?.[0] ?? 0,
    humans: (b.meta?.seats || []).filter((s) => s.kind === "human").length,
  });
}
entries.sort((a, b) => String(b.ended).localeCompare(String(a.ended)));
fs.writeFileSync(path.join(DIR, "index.json"), JSON.stringify(entries, null, 1));
console.log(`indexed ${entries.length} replays`);
for (const e of entries) console.log(`  ${e.id}  ${e.map}  ${e.turns}T`);
