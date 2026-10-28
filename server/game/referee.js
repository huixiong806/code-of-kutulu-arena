// Faithful JavaScript port of the Code of Kutulu referee
// (github.com/JohnnyGuye/code-of-kutulu, as vendored in ../../build/java).
//
// Every rule, ordering decision and tie-break below mirrors the Java source so
// that the CodinGame bots in ../../build/*.exe keep playing exactly as they do
// on the platform.  In particular java.util.Random is reimplemented: replays of
// recorded games reproduce the original entity stream byte for byte.

import { ALL_MAPS } from "./maps.js";

// MazeFactory.bronzeMaps — the exact 16 layouts the platform draws from at
// Legend.  Derived rules matter here: "The random map" and the two/three-start
// debug layouts must never appear, because the bots have never seen them.
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

const PLAYABLE = BRONZE.map((name) => {
  const map = ALL_MAPS.find((m) => m.name === name);
  if (!map) throw new Error(`missing map in maps.js: ${name}`);
  if (map.rows.join("").split("S").length - 1 !== 4) {
    throw new Error(`map ${name} does not have four start cells`);
  }
  return map;
});

const MASK48 = (1n << 48n) - 1n;

/** java.util.Random, bit-exact. */
export class JavaRandom {
  constructor(seed) {
    this.seed = (BigInt(seed) ^ 0x5deece66dn) & MASK48;
  }

  next(bits) {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & MASK48;
    return Number(this.seed >> BigInt(48 - bits));
  }

  nextInt(bound) {
    if (bound === undefined) return this.next(32) | 0;
    if (bound <= 0) throw new Error("bound must be positive");
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    }
    for (;;) {
      const bits = this.next(31);
      const val = bits % bound;
      if (bits - val + (bound - 1) <= 0x7fffffff) return val;
    }
  }
}

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const DIR_NAME = ["UP", "RIGHT", "DOWN", "LEFT"];

const SEL = { WAIT: 0, PLAN: 1, LIGHT: 2, YELL: 3 };
const DIR_ACTION = { UP: DIRS[0], RIGHT: DIRS[1], DOWN: DIRS[2], LEFT: DIRS[3] };

const C = {
  MAX_TURNS: 200,
  MAX_SANITY: 250,
  MAX_PLAN: 2,
  MAX_LIGHT: 3,
  PLAN_DURATION: 4,
  PLAN_RADIUS: 2,
  PLAN_HEAL: 3,
  LIGHT_DURATION: 2,
  LIGHT_RADIUS: 5,
  REPULSE_WEIGHT: 4,
  SHELTER_INTERVAL: 50,
  SHELTER_MAX_ENERGY: 10,
  SHELTER_HEAL: 5,
  YELL_RADIUS: 1,
  YELL_STUCK_TURNS: 2,
  SPAWN_INTERVAL: 5,
  SLASHER_SPAWN_TIME: 6,
  SLASHER_RUSH_PREP: 2,
  SLASHER_RUSH_STUN: 6,
  SLASHER_SANITY: 200,
  MINION_SANITY_LOST: 20,
  NOT_ALONE_RANGE: 2,
  KUTULU_MADNESS: 50,
};

const ST = {
  SPAWNING: 0,
  WANDERING: 1,
  STALKING: 2,
  RUSH: 3,
  STUNNED: 4,
  RECALLING_SUCCESS: 10,
  RECALLING_FAILURE: 11,
};

export class Game {
  /**
   * @param {object} o
   * @param {number|string|bigint} o.seed
   * @param {string} [o.mapName]     force a map (the RNG draw is still consumed)
   * @param {object} [o.params]      force the four randomised constants
   * @param {number} [o.turn]        resume from a turn (replay only)
   * @param {boolean} [o.killOnInvalid]
   */
  constructor(o = {}) {
    this.seed = o.seed;
    this.rng = new JavaRandom(o.seed);
    this.killOnInvalid = o.killOnInvalid !== false;

    // League.LEGEND.activateRules() -> WOOD_1 -> calculateParametrizedConstants()
    // (the four draws are always consumed, even when values are forced,
    //  so a recorded game replays with an identical RNG stream)
    const drawn = {
      lonely: 3 + this.rng.nextInt(4),
      group: 1 + this.rng.nextInt(3),
      spawnTime: 3 + this.rng.nextInt(4),
      life: 30 + this.rng.nextInt(11),
    };
    this.params = o.params ? { ...drawn, ...o.params } : drawn;
    // the referee draws a map draw even when a name is given on the command line
    const draw = this.rng.nextInt();
    const pick = PLAYABLE[Math.abs(draw) % PLAYABLE.length];
    this.map = o.mapName ? ALL_MAPS.find((m) => m.name === o.mapName) || pick : pick;
    if (!this.map) throw new Error("unknown map " + o.mapName);

    this.turn = 0;
    this.nextId = 4;
    this.slasherSpawned = [false, false, false, false];
    this.shelters = [];
    this._buildMap();

    this.players = [0, 1, 2, 3].map((id) => ({
      id,
      x: this.startPos[id].x,
      y: this.startPos[id].y,
      sanity: C.MAX_SANITY,
      plans: C.MAX_PLAN,
      lights: C.MAX_LIGHT,
      alive: true,
      score: 0,
      yellsBy: new Set(),
      wanted: { kind: "WAIT", msg: "" },
      invalidMove: false,
      lastRaw: "",
      deathTurn: null,
      stats: { spook: 0, passive: 0, heal: 0, isolated: 0, plans: 0, lights: 0, yells: 0 },
    }));
    this.minions = [];
    this.effects = [];
    this.events = [];
    this.log = []; // per turn: {turn, events, deltas}
  }

  // ---------------------------------------------------------------- map ----
  _buildMap() {
    this.rows = this.map.rows;
    this.H = this.rows.length;
    this.W = this.rows[0].length;
    this.cells = [];
    this.wandererSpawns = [];
    this.shelterCells = [];
    this.startPos = [];
    for (let y = 0; y < this.H; y++) {
      const row = [];
      for (let x = 0; x < this.W; x++) {
        const ch = this.rows[y][x];
        row.push({
          wall: ch === "#",
          spawn: ch === "w",
          shelter: ch === "U",
          repulse: false,
        });
        if (ch === "w") this.wandererSpawns.push({ x, y });
        if (ch === "U") this.shelterCells.push({ x, y });
        if (ch === "S") this.startPos.push({ x, y });
      }
      this.cells.push(row);
    }
    if (this.startPos.length !== 4) throw new Error("map needs 4 start cells: " + this.map.name);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }

  walkable(x, y) {
    return this.inBounds(x, y) && !this.cells[y][x].wall;
  }

  // ------------------------------------------------------------- helpers ---
  living() {
    return this.players.filter((p) => p.alive);
  }

  active() {
    return this.players.filter((p) => p.alive);
  }

  playerAt(x, y) {
    return this.living().filter((p) => p.x === x && p.y === y);
  }

  manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  /** A* exactly as implemented by codeofkutulu.pathfinder.AStar. */
  _astar(from, to, dirOffset, repulseWeight) {
    const w = (x, y) => 1 + (repulseWeight && this.cells[y][x].repulse ? C.REPULSE_WEIGHT : 0);
    const open = [{ x: from.x, y: from.y, cum: 0, f: 1, prev: null }];
    const closed = new Uint8Array(this.W * this.H);
    while (open.length) {
      const visit = open.shift();
      if (visit.x === to.x && visit.y === to.y) {
        const path = [];
        for (let it = visit; it; it = it.prev) path.unshift({ x: it.x, y: it.y });
        return { path, cost: visit.cum };
      }
      const key = visit.y * this.W + visit.x;
      if (closed[key]) continue;
      closed[key] = 1;
      for (let i = 0; i < 4; i++) {
        const d = (i + dirOffset) % 4;
        const nx = visit.x + DIRS[d][0];
        const ny = visit.y + DIRS[d][1];
        if (!this.walkable(nx, ny)) continue;
        if (closed[ny * this.W + nx]) continue;
        const cum = visit.cum + w(nx, ny);
        open.push({ x: nx, y: ny, cum, f: cum + 1, prev: visit });
      }
      // stable sort by f, exactly like Collections.sort
      open.sort((a, b) => a.f - b.f);
    }
    return null;
  }

  stepToward(px, py, tx, ty) {
    if (!this.walkable(tx, ty)) return null;
    const r = this._astar({ x: px, y: py }, { x: tx, y: ty }, 0, false);
    if (!r || r.path.length < 2) return null;
    return r.path[1];
  }

  // ------------------------------------------------------------ actions ---
  // Port of com.codingame.game.PlayerAction
  parseAction(p, line) {
    p.invalidMove = false;
    let raw = String(line ?? "").trim();
    const move = /^MOVE\s+(-?\d+)\s+(-?\d+)(?:\s+(.+))?\s*$/i.exec(raw);
    if (move) {
      const tx = Number(move[1]);
      const ty = Number(move[2]);
      const next = this.stepToward(p.x, p.y, tx, ty);
      if (!next) {
        p.invalidMove = true;
        return { kind: "WAIT", msg: (move[3] || "").trim(), raw };
      }
      const dx = next.x - p.x;
      const dy = next.y - p.y;
      const dir = DIRS.findIndex((d) => d[0] === dx && d[1] === dy);
      return { kind: DIR_NAME[dir], msg: (move[3] || "").trim(), raw };
    }
    const other = /^(\w+)(?:\s+(.+))?\s*$/i.exec(raw);
    if (!other) return { kind: "WAIT", msg: "", raw, invalid: true };
    const word = other[1].toUpperCase();
    const msg = (other[2] || "").trim();
    if (!["WAIT", "UP", "DOWN", "LEFT", "RIGHT", "PLAN", "LIGHT", "YELL"].includes(word)) {
      return { kind: "WAIT", msg, raw, invalid: true };
    }
    return { kind: word, msg, raw };
  }

  // -------------------------------------------------------------- input ---
  /** Lines a given player's bot receives this turn (Referee.sendInput). */
  inputFor(playerId) {
    const out = [];
    const idx = playerId;
    for (let i = 0; i < 4; i++) {
      const p = this.players[(i + idx) % 4];
      if (!p.alive) continue;
      out.push(this.explorerLine(p));
    }
    for (const m of this.minions) out.push(this.minionLine(m));
    for (const e of this.effects) {
      const line = this.effectLine(e);
      if (line) out.push(line);
    }
    return [String(out.length), ...out];
  }

  /** Full initial input block (sent once, before turn 0). */
  initInput() {
    const rows = this.rows.map((r) => r.replace(/S/g, ".").replace(/U/g, "U"));
    return [
      String(this.W),
      String(this.H),
      ...rows,
      `${this.params.lonely} ${this.params.group} ${this.params.spawnTime} ${this.params.life}`,
    ];
  }

  explorerLine(p) {
    return `EXPLORER ${p.id} ${p.x} ${p.y} ${p.sanity} ${p.plans} ${p.lights}`;
  }

  minionLine(m) {
    const cd = this.minionCountdown(m);
    const target = m.target && m.target.alive ? m.target.id : -1;
    return `${m.kind === "W" ? "WANDERER" : "SLASHER"} ${m.id} ${m.x} ${m.y} ${cd} ${m.state} ${target}`;
  }

  minionCountdown(m) {
    if (m.state === ST.SPAWNING) return m.spawnCountdown;
    if (m.state === ST.STALKING || m.state === ST.STUNNED) return m.stunCountdown;
    return m.lifeTimeCountdown;
  }

  effectLine(e) {
    const t = e.kind;
    if (t === "SHELTER") return `EFFECT_SHELTER -1 ${e.cell.x} ${e.cell.y} ${e.tick} -1 -1`;
    if (t === "PLAN") return `EFFECT_PLAN -1 ${e.caster.x} ${e.caster.y} ${e.tick} ${e.caster.id} -1`;
    if (t === "LIGHT") return `EFFECT_LIGHT -1 ${e.caster.x} ${e.caster.y} ${e.tick} ${e.caster.id} -1`;
    if (t === "YELL") {
      if (!e.receiver.alive) return null;
      return `EFFECT_YELL -1 -1 -1 ${e.tick} ${e.caster.id} ${e.receiver.id}`;
    }
    return null;
  }

  // --------------------------------------------------------------- turn ---
  /**
   * Advance one turn.
   * @param {(id:number)=>string} getAction
   * @returns {{turn:number, events:string[], deltas:number[]}}
   */
  step(getAction, opts = {}) {
    const timeoutKills = opts.timeoutKills !== false;
    const events = [];
    const turn = this.turn;
    const before = this.players.map((p) => p.sanity);

    // 1. parse outputs (a crashing/timing-out bot dies, like the platform)
    for (const p of this.active()) {
      const raw = getAction(p.id);
      p.lastRaw = raw == null ? "" : String(raw);
      if (raw == null) {
        if (timeoutKills) {
          this.killPlayer(p, events);
          continue;
        }
        p.wanted = { kind: "WAIT", msg: "", raw: "" };
        continue;
      }
      const parsed = this.parseAction(p, raw);
      if (parsed.invalid) {
        events.push(`Invalid command by $${p.id}.`);
        if (this.killOnInvalid) {
          this.killPlayer(p, events);
          continue;
        }
        p.wanted = { kind: "WAIT", msg: "", raw };
        continue;
      }
      p.wanted = parsed;
    }

    // state the players are about to see (post-parse: timed-out bots are gone)
    const parsedEntities = this.entityLines();

    // 2. phases, in the exact order of Referee.updateGame()
    this.resetEffects();
    this.spawnMinions(events);
    this.doPlayerAction(events);
    this.doEffects();
    this.updateMinions(events);
    this.recallMinions();
    this.spreadMadness(events);
    this.removeDeadPlayers(events);
    this.spawnShelters();

    const deltas = this.players.map((p, i) => p.sanity - before[i]);
    this.events = events;
    this.log.push({ turn, events, deltas });
    this.turn++;
    if (this.active().length === 0) this.finished = true;
    if (this.turn > C.MAX_TURNS) {
      this.finished = true;
      for (const p of this.active()) p.score = turn + p.sanity;
    }
    return { turn, events, deltas, parsed: parsedEntities };
  }

  killPlayer(p, events) {
    p.alive = false;
    p.sanity = 0;
    p.score = -1;
    p.deathTurn = this.turn;
    this.removeThePlayer(p);
    events.push(`$${p.id} timeout!`);
  }

  resetEffects() {
    for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) this.cells[y][x].repulse = false;
  }

  spawnMinions(events) {
    // slashers first
    for (const p of this.living()) {
      if (!this.slasherSpawned[p.id] && p.sanity < C.SLASHER_SANITY) {
        this.slasherSpawned[p.id] = true;
        this.minions.push({
          id: this.nextId++,
          kind: "S",
          x: p.x,
          y: p.y,
          state: ST.SPAWNING,
          spawnCountdown: C.SLASHER_SPAWN_TIME,
          lifeTimeCountdown: this.params.life,
          stunCountdown: 0,
          dirOffset: this.rng.nextInt(4),
          target: p,
          prepTarget: { x: p.x, y: p.y },
        });
      }
    }
    // wanderers every 5 turns at the spawn point furthest from every player
    if (this.turn % C.SPAWN_INTERVAL !== 0) return;
    const spawns = this.wandererSpawns;
    if (!spawns.length) return;
    const limits = this.W + this.H;
    const dists = spawns.map(() => limits);
    spawns.forEach((s, i) => {
      for (const p of this.living()) dists[i] = Math.min(dists[i], Math.abs(p.x - s.x) + Math.abs(p.y - s.y));
    });
    const maxOfMins = Math.max(...dists);
    spawns.forEach((s, i) => {
      if (dists[i] !== maxOfMins) return;
      this.minions.push({
        id: this.nextId++,
        kind: "W",
        x: s.x,
        y: s.y,
        state: ST.SPAWNING,
        spawnCountdown: this.params.spawnTime,
        lifeTimeCountdown: this.params.life,
        stunCountdown: 0,
        dirOffset: this.rng.nextInt(4),
        target: null,
        prepTarget: null,
      });
    });
  }

  // YELL first, then everyone else
  doPlayerAction(events) {
    this.resetStuck(events);
    for (const p of this.active()) {
      if (p.wanted.kind !== "YELL") continue;
      p.stats.yells++;
      for (const o of this.active()) {
        if (o === p) continue;
        const ok = this.yell(p, o);
        if (ok) events.push(`$${o.id} fooled by $${p.id}`);
      }
    }
    this.resetStuck(events);

    for (const p of this.active()) {
      const w = p.wanted;
      if (this.isStuck(p)) {
        if (w.kind !== "WAIT") {
          p.wanted = { kind: "WAIT", msg: w.msg, raw: w.raw };
          events.push(`$${p.id} stuck`);
        }
        continue;
      }
      let nx = p.x;
      let ny = p.y;
      if (w.kind === "UP" || w.kind === "DOWN" || w.kind === "LEFT" || w.kind === "RIGHT") {
        const d = DIR_ACTION[w.kind];
        nx += d[0];
        ny += d[1];
      }
      if (!this.walkable(nx, ny) || p.invalidMove) {
        events.push(`Invalid move from $${p.id}`);
        continue;
      }
      p.x = nx;
      p.y = ny;
      if (w.kind === "PLAN" || w.kind === "LIGHT") {
        if (this.hasEffectOf(p)) {
          events.push(`Invalid effect from $${p.id}`);
          continue;
        }
        if (w.kind === "PLAN" && p.plans > 0) {
          p.plans--;
          p.stats.plans++;
          this.effects.push({ kind: "PLAN", caster: p, tick: C.PLAN_DURATION });
        } else if (w.kind === "LIGHT" && p.lights > 0) {
          p.lights--;
          p.stats.lights++;
          this.effects.push({ kind: "LIGHT", caster: p, tick: C.LIGHT_DURATION });
        } else {
          events.push(`Invalid effect from $${p.id}`);
        }
      }
    }
  }

  resetStuck(events) {
    for (const p of this.active()) {
      if (this.isStuck(p) && p.wanted.kind !== "WAIT") {
        p.wanted = { kind: "WAIT", msg: p.wanted.msg, raw: p.wanted.raw };
        events.push(`$${p.id} stuck`);
      }
    }
  }

  yell(from, to) {
    if (to === from) return false;
    if (this.manhattan(from, to) > C.YELL_RADIUS) return false;
    if (to.yellsBy.has(from.id)) return false;
    to.yellsBy.add(from.id);
    this.effects.push({ kind: "YELL", caster: from, receiver: to, tick: C.YELL_STUCK_TURNS });
    return true;
  }

  isStuck(p) {
    return this.effects.some((e) => e.kind === "YELL" && e.receiver === p);
  }

  hasEffectOf(p) {
    return this.effects.some((e) => e.caster === p);
  }

  bfsCells(start, radius) {
    const seen = new Set();
    let frontier = [start];
    const out = [];
    for (let d = 0; d <= radius; d++) {
      const next = [];
      for (const c of frontier) {
        const k = c.y * this.W + c.x;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
        for (const [dx, dy] of DIRS) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          if (!this.walkable(nx, ny)) continue;
          const nk = ny * this.W + nx;
          if (seen.has(nk)) continue;
          next.push({ x: nx, y: ny });
        }
      }
      frontier = next;
    }
    return out;
  }

  doEffects() {
    for (const e of this.effects) {
      if (e.tick <= 0) continue;
      if (e.kind === "PLAN") {
        e.caster.sanity = Math.min(C.MAX_SANITY, e.caster.sanity + C.PLAN_HEAL);
        e.caster.stats.heal += C.PLAN_HEAL;
        for (const c of this.bfsCells({ x: e.caster.x, y: e.caster.y }, C.PLAN_RADIUS)) {
          for (const o of this.living()) {
            if (o === e.caster) continue;
            if (o.x === c.x && o.y === c.y) {
              o.sanity = Math.min(C.MAX_SANITY, o.sanity + C.PLAN_HEAL);
              o.stats.heal += C.PLAN_HEAL;
              e.caster.sanity = Math.min(C.MAX_SANITY, e.caster.sanity + C.PLAN_HEAL);
              e.caster.stats.heal += C.PLAN_HEAL;
            }
          }
        }
        e.tick--;
      } else if (e.kind === "LIGHT") {
        for (const c of this.bfsCells({ x: e.caster.x, y: e.caster.y }, C.LIGHT_RADIUS)) {
          this.cells[c.y][c.x].repulse = true;
        }
        e.tick--;
      } else if (e.kind === "SHELTER") {
        let healed = 0;
        for (const p of this.living()) {
          if (p.x === e.cell.x && p.y === e.cell.y) {
            p.sanity = Math.min(C.MAX_SANITY, p.sanity + C.SHELTER_HEAL);
            p.stats.heal += C.SHELTER_HEAL;
            healed++;
          }
        }
        e.tick = Math.max(0, e.tick - healed);
      } else if (e.kind === "YELL") {
        e.tick--;
      }
    }
    this.effects = this.effects.filter((e) => e.tick > 0);
  }

  updateMinions(events) {
    for (const m of this.minions) {
      if (m.kind === "W") this.updateWanderer(m);
      else this.updateSlasher(m);
    }
  }

  updateWanderer(m) {
    if (m.state === ST.SPAWNING) {
      m.spawnCountdown--;
      if (m.spawnCountdown === 0) {
        m.state = ST.WANDERING;
        m.lifeTimeCountdown = this.params.life;
      }
      return;
    }
    if (m.state === ST.RECALLING_FAILURE || m.state === ST.RECALLING_SUCCESS) return;
    this.chaseClosest(m);
    if (this.spookCell(m.x, m.y)) {
      m.state = ST.RECALLING_SUCCESS;
    } else {
      m.lifeTimeCountdown--;
      if (m.lifeTimeCountdown === 0) m.state = ST.RECALLING_FAILURE;
    }
  }

  updateSlasher(m) {
    switch (m.state) {
      case ST.SPAWNING:
        m.spawnCountdown--;
        if (m.spawnCountdown === 0) m.state = ST.RUSH;
        break;
      case ST.STALKING:
        m.stunCountdown--;
        this.acquireTarget(m);
        if (m.stunCountdown <= 0) m.state = ST.RUSH;
        break;
      case ST.RUSH: {
        this.rush(m);
        m.state = ST.STUNNED;
        m.stunCountdown = C.SLASHER_RUSH_STUN;
        break;
      }
      case ST.STUNNED:
        m.stunCountdown--;
        if (m.stunCountdown === 0) m.state = ST.WANDERING;
        break;
      case ST.RECALLING_FAILURE:
      case ST.RECALLING_SUCCESS:
        break;
      default:
        if (this.acquireTarget(m)) {
          m.stunCountdown = C.SLASHER_RUSH_PREP;
          m.state = ST.STALKING;
        } else {
          this.chaseClosest(m);
        }
    }
  }

  rush(m) {
    if (this.acquireTarget(m)) {
      m.x = m.target.x;
      m.y = m.target.y;
    } else if (m.prepTarget) {
      m.x = m.prepTarget.x;
      m.y = m.prepTarget.y;
    }
    this.spookCell(m.x, m.y);
    m.target = null;
    m.prepTarget = null;
  }

  acquireTarget(m) {
    if (m.target && !m.target.alive) {
      m.target = null;
      m.prepTarget = null;
    }
    if (m.target && this.inLoS(m, m.target)) {
      m.prepTarget = { x: m.target.x, y: m.target.y };
      return true;
    }
    const targets = this.closestTargets(m);
    if (targets.length === 0) {
      // Java keeps targetPositionBeforePreparation here: the slasher still
      // remembers where it last saw someone.
      m.target = null;
      return false;
    }
    if (targets.length === 1) {
      m.target = targets[0];
      m.prepTarget = { x: m.target.x, y: m.target.y };
      return true;
    }
    // can't decide which one to target
    m.target = null;
    m.prepTarget = null;
    return false;
  }

  inLoS(m, player) {
    for (let d = 0; d < 4; d++) {
      let x = m.x;
      let y = m.y;
      while (this.walkable(x, y)) {
        if (player.x === x && player.y === y) return true;
        x += DIRS[d][0];
        y += DIRS[d][1];
      }
    }
    return false;
  }

  closestTargets(m) {
    let minDepth = Math.max(this.W, this.H);
    let targets = [];
    for (let d = 0; d < 4; d++) {
      let x = m.x;
      let y = m.y;
      while (this.walkable(x, y)) {
        const here = this.playerAt(x, y);
        if (here.length) {
          const depth = Math.max(Math.abs(x - m.x), Math.abs(y - m.y));
          if (depth < minDepth) {
            targets = [...here];
            minDepth = depth;
          } else if (depth === minDepth) {
            targets = targets.concat(here.filter((p) => !targets.includes(p)));
          }
          break;
        }
        x += DIRS[d][0];
        y += DIRS[d][1];
      }
    }
    return targets;
  }

  chaseClosest(m) {
    let best = null;
    let bestTarget = null;
    const order = this.shuffledTargets(m.target, m.dirOffset);
    for (const p of order) {
      const r = this._astar({ x: m.x, y: m.y }, { x: p.x, y: p.y }, this.turn, true);
      if (!r) continue;
      if (
        !best ||
        r.cost < best.cost ||
        (r.cost === best.cost && p === m.target)
      ) {
        best = r;
        bestTarget = p;
      }
    }
    if (best) {
      m.target = bestTarget;
      if (best.path.length > 1) {
        m.x = best.path[1].x;
        m.y = best.path[1].y;
      }
    }
  }

  /** Minion.fisherYatesShuffle: previous target first, random remainder. */
  shuffledTargets(prevTarget, _offset) {
    const living = this.living();
    const idx = living.map((_, i) => i);
    let start = 0;
    if (prevTarget && prevTarget.alive) {
      const at = living.indexOf(prevTarget);
      if (at >= 0) {
        idx[at] = 0;
        idx[0] = at;
        start = 1;
      }
    }
    for (let i = start; i < idx.length - 1; i++) {
      const rnd = this.rng.nextInt(idx.length - i) + i;
      const t = idx[i];
      idx[i] = idx[rnd];
      idx[rnd] = t;
    }
    return idx.map((i) => living[i]);
  }

  spookCell(x, y) {
    const hit = this.playerAt(x, y);
    for (const p of hit) {
      p.sanity -= C.MINION_SANITY_LOST;
      p.stats.spook += C.MINION_SANITY_LOST;
      if (p.sanity <= 0) p.sanity = 0;
    }
    return hit.length > 0;
  }

  recallMinions() {
    this.minions = this.minions.filter(
      (m) => m.state !== ST.RECALLING_SUCCESS && m.state !== ST.RECALLING_FAILURE
    );
  }

  spreadMadness(events) {
    // Referee.spreadMadness: the last survivor is chased by Kutulu itself
    if (this.living().length === 1) {
      const p = this.living()[0];
      p.sanity -= C.KUTULU_MADNESS;
      p.stats.passive += C.KUTULU_MADNESS;
      if (p.sanity <= 0) p.sanity = 0;
      return;
    }
    for (const p of this.living()) {
      let isolated = true;
      for (const o of this.living()) {
        if (o === p) continue;
        if (this.manhattan(p, o) <= C.NOT_ALONE_RANGE) isolated = false;
      }
      const loss = isolated ? this.params.lonely : this.params.group;
      p.sanity -= loss;
      p.stats.passive += loss;
      if (isolated) p.stats.isolated++;
      if (p.sanity <= 0) p.sanity = 0;
    }
  }

  removeDeadPlayers(events) {
    for (const p of this.players) {
      if (p.alive && p.sanity <= 0) {
        this.removeThePlayer(p);
        p.alive = false;
        p.score = this.turn;
        p.deathTurn = this.turn;
        events.push(`$${p.id} frightened to death`);
      }
    }
  }

  removeThePlayer(p) {
    p.alive = false;
    this.effects = this.effects.filter((e) => !(e.caster === p && e.kind !== "YELL"));
  }

  spawnShelters() {
    if (this.turn === 0 || this.turn % C.SHELTER_INTERVAL !== 0) return;
    this.effects = this.effects.filter((e) => e.kind !== "SHELTER");
    for (const c of this.shelterCells) {
      this.effects.push({ kind: "SHELTER", cell: { ...c }, tick: C.SHELTER_MAX_ENERGY });
    }
  }

  // ------------------------------------------------------------- view ---
  entityLines() {
    const entities = [];
    for (const p of this.players) if (p.alive) entities.push(this.explorerLine(p));
    for (const m of this.minions) entities.push(this.minionLine(m));
    for (const e of this.effects) {
      const line = this.effectLine(e);
      if (line) entities.push(line);
    }
    return entities;
  }

  snapshot() {
    const entities = this.entityLines();
    return {
      turn: this.turn,
      map: this.map.name,
      seed: String(this.seed),
      params: [this.params.lonely, this.params.group, this.params.spawnTime, this.params.life],
      width: this.W,
      height: this.H,
      entities,
      players: this.players.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        sanity: p.sanity,
        plans: p.plans,
        lights: p.lights,
        alive: p.alive,
        score: p.score,
        deathTurn: p.deathTurn,
        stats: p.stats,
      })),
      events: this.events,
      finished: this.turn > C.MAX_TURNS || this.active().length === 0,
    };
  }

  /** Final standings: survivors ranked by sanity, dead by death turn. */
  standings() {
    const arr = this.players.map((p) => ({
      id: p.id,
      alive: p.alive,
      sanity: p.sanity,
      score: p.alive ? this.turn - 1 + p.sanity : p.score,
    }));
    arr.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.alive) return b.sanity - a.sanity;
      return b.score - a.score;
    });
    return arr;
  }
}

export const CONSTANTS = C;
export const STATES = ST;
export const PLAYABLE_MAPS = PLAYABLE;
