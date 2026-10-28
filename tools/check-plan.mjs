/**
 * PLAN 的实际数值断言：施放者 3 + 3×同伴数，每个同伴 3。
 *   node tools/check-plan.mjs
 */
import { Game } from "../server/game/referee.js";

function findCluster(game, n) {
  for (let y = 1; y < game.H - 1; y++) {
    for (let x = 1; x < game.W - 1; x++) {
      if (!game.walkable(x, y)) continue;
      const cells = [{ x, y }];
      for (let dy = -2; dy <= 2 && cells.length < n; dy++) {
        for (let dx = -2; dx <= 2 && cells.length < n; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!game.walkable(nx, ny)) continue;
          if (cells.some((c) => c.x === nx && c.y === ny)) continue;
          if (Math.abs(dx) + Math.abs(dy) > 2) continue;
          cells.push({ x: nx, y: ny });
        }
      }
      if (cells.length >= n) return cells.slice(0, n);
    }
  }
  return null;
}

function run(allies) {
  const game = new Game({ seed: 12345n, mapName: "Cross" });
  const cells = findCluster(game, allies + 1);
  if (!cells) throw new Error("no cluster found");
  // keep the caster and `allies` teammates inside the radius
  game.players.forEach((p, i) => {
    const c = cells[Math.min(i, cells.length - 1)];
    p.x = c.x;
    p.y = c.y;
    p.sanity = 100;
    p.plans = 2;
  });
  // park the unused seats far away so they neither heal nor group up
  for (let i = allies + 1; i < 4; i++) {
    const far = game.players[i];
    for (let y = 1; y < game.H - 1; y++) {
      for (let x = 1; x < game.W - 1; x++) {
        if (!game.walkable(x, y)) continue;
        if (cells.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) <= 3)) continue;
        far.x = x;
        far.y = y;
        break;
      }
      if (far.x !== 0) break;
    }
  }

  game.players.forEach((p) => (p.stats.heal = 0));
  game.step((id) => (id === 0 ? "PLAN" : "WAIT"));

  const heal = game.players.map((p) => p.stats.heal);
  const passive = game.players.map((p) => p.stats.passive);
  return { heal, passive, params: game.params };
}

let bad = 0;
for (const allies of [0, 1, 2, 3]) {
  const { heal, passive, params } = run(allies);
  const expectCaster = 3 + 3 * allies;
  const ok = heal[0] === expectCaster && heal.slice(1, allies + 1).every((h) => h === 3 * 1);
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "FAIL"} PLAN 圈内同伴 ${allies} 人 → 施放者回 ${heal[0]}（期望 ${expectCaster}）` +
      `，同伴回 ${heal.slice(1, allies + 1).join("/") || "—"}` +
      `，本回合被动 -${passive[0]}（lonely=${params.lonely} group=${params.group}）`
  );
}
process.exit(bad ? 1 : 0);
