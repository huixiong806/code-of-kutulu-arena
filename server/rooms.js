/**
 * Rooms: lobby, seats, turn clock and the bridge between human clients,
 * AI subprocesses and the referee.
 *
 * Turn clock (mahjong style): every player owns a per-turn allowance
 * (stepMs, default 5s) plus a personal bank (bankMs, default 10s) that is only
 * consumed for the time spent beyond the per-turn allowance.  When both are
 * exhausted the server plays WAIT for that seat so the table never stalls.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Game } from "./game/referee.js";
import { BotProcess, difficultyInfo, resolveDifficulty, availableBots } from "./game/bots.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();

export function roomList() {
  return [...rooms.values()]
    .filter((r) => r.state === "lobby" || r.state === "playing")
    .map((r) => r.publicInfo());
}

export function getRoom(id) {
  return rooms.get(String(id || "").toUpperCase());
}

export function allRooms() {
  return [...rooms.values()];
}

export function createRoom(opts) {
  let id;
  do {
    id = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  } while (rooms.has(id));
  const room = new Room(id, opts);
  rooms.set(id, room);
  return room;
}

function shortId(n = 8) {
  return crypto.randomBytes(n).toString("hex").slice(0, n);
}

function avatarFor(name) {
  const clean = String(name || "").trim();
  if (!clean) return "?";
  // emoji / CJK / letter: take the first visible grapheme
  const g = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(clean)];
  return (g[0]?.segment || "?").toUpperCase().slice(0, 2);
}

export class Room extends EventEmitter {
  constructor(id, opts = {}) {
    super();
    this.id = id;
    this.name = (opts.name || "库图鲁的墓穴").slice(0, 24);
    this.hostToken = opts.hostToken || shortId(12);
    this.createdAt = Date.now();
    this.state = "lobby"; // lobby | playing | between | finished | closed
    this.clients = new Set();
    this.seats = [0, 1, 2, 3].map((i) => ({
      seat: i,
      kind: "empty", // empty | human | ai
      name: "",
      avatar: "?",
      token: null,
      difficulty: "medium",
      connected: false,
      ready: false,
      bankMs: null,
      action: null,
      actedAt: 0,
      usedBank: 0,
    }));
    this.settings = {
      stepMs: clampInt(opts.stepMs, 2000, 60000, 5000),
      bankMs: clampInt(opts.bankMs, 0, 120000, 10000),
      games: [1, 5, 10, 20].includes(Number(opts.games)) ? Number(opts.games) : 1,
      // pause between turns that were resolved purely by AI, so spectators can follow
      paceMs: clampInt(opts.paceMs, 0, 5000, 800),
      visibility: opts.visibility === "private" ? "private" : "public",
    };
    this.game = null;
    this.bots = new Map();
    this.turnSeq = 0;
    this.turnStartedAt = 0;
    this.deadlineAt = 0;
    this.timer = null;
    this.nextTimer = null;
    this.paceTimer = null;
    this.turnOpen = false;
    this.replay = null;
    this.log = [];
    this.series = null;
  }

  // ------------------------------------------------------------ lobby ----
  publicInfo() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      players: this.seats.filter((s) => s.kind !== "empty").length,
      seated: this.seats.map((s) => (s.kind === "empty" ? null : { kind: s.kind, name: s.name, avatar: s.avatar })),
      settings: this.settings,
      createdAt: this.createdAt,
    };
  }

  stateFor(viewer) {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      settings: this.settings,
      host: viewer && viewer.token === this.hostToken,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        kind: s.kind,
        name: s.name,
        avatar: s.avatar,
        difficulty: s.difficulty,
        desc: s.kind === "ai" ? difficultyInfo(s.difficulty).desc : "",
        connected: s.connected,
        ready: s.ready,
        you: !!viewer && s.token === viewer.token,
        bank:
          this.game && s.kind === "human" && s.seat === (viewer && viewer.seat)
            ? Math.max(0, Math.round((s.bankMs ?? this.settings.bankMs) - s.usedBank))
            : null,
      })),
      replayId: this.replay,
      series: this.series ? this.seriesSummary() : null,
    };
  }

  join({ name, token }) {
    const existing = token ? this.seats.find((s) => s.token === token) : null;
    if (existing) {
      existing.connected = true;
      return { seat: existing.seat, token: existing.token, resumed: true };
    }
    // the host keeps its identity even after giving the seat away to an AI
    if (token && token === this.hostToken) {
      return { seat: -1, token, spectator: true, host: true };
    }
    if (this.state !== "lobby") {
      // late arrivals become spectators
      const spectatorToken = shortId(12);
      return { seat: -1, token: spectatorToken, spectator: true };
    }
    const seat = this.seats.find((s) => s.kind === "empty");
    if (!seat) return { error: "房间已满" };
    const clean = String(name || "").trim().slice(0, 16) || `玩家${seat.seat + 1}`;
    seat.kind = "human";
    seat.name = clean;
    seat.avatar = avatarFor(clean);
    seat.token = shortId(12);
    seat.connected = true;
    seat.ready = true;
    this.touch();
    return { seat: seat.seat, token: seat.token };
  }

  setSeat(seatIndex, patch, token) {
    if (token !== this.hostToken) return { error: "只有房主可以调整座位" };
    if (this.state !== "lobby") return { error: "对局已经开始" };
    const seat = this.seats[seatIndex];
    if (!seat) return { error: "座位不存在" };
    if (patch.kind === "ai") {
      seat.kind = "ai";
      seat.token = null;
      seat.connected = true;
      seat.difficulty = resolveDifficulty(patch.difficulty);
      const info = difficultyInfo(seat.difficulty);
      seat.name = `${info.label} AI ${seatIndex + 1}`;
      seat.avatar = info.avatar;
      seat.ready = true;
    } else if (patch.kind === "empty") {
      seat.kind = "empty";
      seat.token = null;
      seat.name = "";
      seat.avatar = "?";
      seat.connected = false;
      seat.ready = false;
    } else if (patch.kind === "human") {
      seat.kind = "human";
      seat.token = null;
      seat.name = "";
      seat.avatar = "?";
      seat.connected = false;
      seat.ready = false;
    }
    if (patch.difficulty && seat.kind === "ai") {
      seat.difficulty = resolveDifficulty(patch.difficulty);
      const info = difficultyInfo(seat.difficulty);
      seat.name = `${info.label} AI ${seatIndex + 1}`;
      seat.avatar = info.avatar;
    }
    this.touch();
    return { ok: true };
  }

  setSettings(patch, token) {
    if (token !== this.hostToken) return { error: "只有房主可以修改设置" };
    if (this.state !== "lobby") return { error: "对局已经开始" };
    if (patch.stepMs != null) this.settings.stepMs = clampInt(patch.stepMs, 2000, 60000, 5000);
    if (patch.bankMs != null) this.settings.bankMs = clampInt(patch.bankMs, 0, 120000, 10000);
    if (patch.paceMs != null) this.settings.paceMs = clampInt(patch.paceMs, 0, 5000, 800);
    if (patch.games != null) {
      const g = Number(patch.games);
      if ([1, 5, 10, 20].includes(g)) this.settings.games = g;
    }
    if (patch.name) this.name = String(patch.name).slice(0, 24);
    if (patch.visibility) this.settings.visibility = patch.visibility === "private" ? "private" : "public";
    this.touch();
    return { ok: true };
  }

  clearPace() {
    if (this.paceTimer) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
  }

  touch() {
    for (const c of this.clients) c.send("state", this.stateFor(c));
  }

  // ------------------------------------------------------------- start ---
  start(token) {
    if (token !== this.hostToken) return { error: "只有房主可以开始对局" };
    if (this.state !== "lobby") return { error: "对局已经开始" };
    const filled = this.seats.filter((s) => s.kind !== "empty");
    if (!filled.length) return { error: "至少需要一个座位（玩家或 AI）" };
    if (this.seats.some((s) => s.kind === "ai") && availableBots().length === 0) {
      return { error: "没有可用的 AI 程序：把 bot 可执行文件放进 bots/ 再开局" };
    }
    // empty seats are filled with medium AI so a game always has four explorers
    for (const s of this.seats) {
      if (s.kind === "empty") {
        const info = difficultyInfo(resolveDifficulty("medium"));
        s.kind = "ai";
        s.difficulty = info.key;
        s.name = `${info.label} AI ${s.seat + 1}`;
        s.avatar = info.avatar;
        s.connected = true;
      }
    }
    this.series = {
      games: clampInt(this.settings.games, 1, 20, 1),
      index: 0,
      results: [],
      totals: [0, 0, 0, 0],
      done: false,
      active: true,
      nextAt: null,
    };
    this.startGame();
    return { ok: true };
  }

  /** Create the game for the current series round and start its first turn. */
  startGame() {
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.clearPace();
    this.state = "playing";
    const seed = BigInt(Math.floor(Math.random() * 1e15)) * (Math.random() < 0.5 ? -1n : 1n);
    this.game = new Game({ seed });
    this.turnSeq = 0;
    this.log = [];
    this._feed = [];
    this.replay = null;
    for (const s of this.seats) {
      s.bankMs = this.settings.bankMs;
      s.usedBank = 0;
      s.action = null;
    }
    this.series.index += 1;
    this.series.nextAt = null;
    this.stopBots();
    this.startBots();
    this.pushFeed(`第 ${this.series.index}/${this.series.games} 局开始 · ${this.game.map.name}`);
    this.touch();
    this.beginTurn();
  }

  /** Host asks for the next round of the series. */
  nextGame(token) {
    if (token !== this.hostToken) return { error: "只有房主可以开始下一局" };
    if (!this.series || this.state !== "between") return { error: "现在不能开下一局" };
    if (this.series.done) return { error: "系列赛已经结束" };
    this.startGame();
    return { ok: true };
  }

  /** Host stops the series early: current totals become final. */
  endSeries(token) {
    if (token !== this.hostToken) return { error: "只有房主可以结束系列赛" };
    if (!this.series || (this.state !== "between" && this.state !== "playing")) {
      return { error: "系列赛没有在进行" };
    }
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.clearPace();
    this.turnOpen = false;
    this.stopBots();
    this.series.done = true;
    this.series.nextAt = null;
    this.state = "finished";
    this.broadcast("series", this.seriesSummary());
    this.touch();
    return { ok: true };
  }

  startBots() {
    for (const s of this.seats) {
      if (s.kind !== "ai") continue;
      const bot = new BotProcess(s.difficulty, { timeoutMs: 2500 });
      try {
        bot.start();
        bot.writeTurn(this.game.initInput());
        this.bots.set(s.seat, bot);
      } catch (err) {
        console.error(`[room ${this.id}] bot ${s.difficulty} failed:`, err.message);
      }
    }
  }

  stopBots() {
    for (const bot of this.bots.values()) bot.stop();
    this.bots.clear();
  }

  // -------------------------------------------------------------- turns ---
  async beginTurn() {
    if (!this.game || this.state !== "playing") return;
    this.turnOpen = true;
    const seq = ++this.turnSeq;
    const game = this.game;
    const now = Date.now();
    this.turnStartedAt = now;

    for (const s of this.seats) {
      s.action = null;
      s.actedAt = 0;
      s.usedBank = 0;
    }

    // AI seats answer immediately
    for (const s of this.seats) {
      if (s.kind !== "ai") continue;
      const bot = this.bots.get(s.seat);
      if (!bot) {
        s.action = "WAIT";
        continue;
      }
      bot.ask(game.inputFor(s.seat)).then((line) => {
        if (seq !== this.turnSeq) return;
        this.handleAction(s.seat, line == null ? "WAIT" : line, true);
      });
    }

    // humans get the private turn view
    this.broadcastTurn();

    const waiting = this.seats.filter((s) => this.isPlayingSeat(s));
    if (!waiting.length) return;
    const maxBank = Math.max(...waiting.map((s) => this.bankLeft(s)));
    this.deadlineAt = now + this.settings.stepMs + maxBank;
    this.ensureTimer();
  }

  isPlayingSeat(s) {
    if (!this.game) return false;
    if (s.kind === "empty") return false;
    const p = this.game.players[s.seat];
    return !!(p && p.alive);
  }

  bankLeft(s) {
    return Math.max(0, (s.bankMs ?? this.settings.bankMs) - s.usedBank);
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tickClock(), 90);
  }

  tickClock() {
    if (this.state !== "playing" || !this.game) return;
    const now = Date.now();
    let changed = false;
    for (const s of this.seats) {
      if (s.action != null || !this.isPlayingSeat(s)) continue;
      const allowance = this.settings.stepMs + this.bankLeft(s);
      if (now - this.turnStartedAt >= allowance) {
        s.action = "WAIT";
        s.actedAt = now;
        s.usedBank = s.bankMs ?? this.settings.bankMs;
        changed = true;
        this.emit("timeout", { seat: s.seat });
        this.pushFeed(`${s.name} 超时，自动 WAIT`);
      }
    }
    if (changed) this.broadcastTurn();
    const pending = this.seats.filter((s) => this.isPlayingSeat(s) && s.action == null);
    if (!pending.length) this.resolveTurn();
    else if (now > this.deadlineAt + 3000) {
      // absolute safety net
      for (const s of pending) {
        s.action = "WAIT";
        s.actedAt = now;
      }
      this.resolveTurn();
    }
  }

  submit(seat, action, token, turn) {
    const s = this.seats[seat];
    if (!s || this.state !== "playing") return { error: "对局未进行" };
    if (s.kind !== "human" || s.token !== token) return { error: "不是你的座位" };
    if (turn != null && Number(turn) !== this.game.turn) return { error: "回合已翻页" };
    if (!this.isPlayingSeat(s)) return { error: "你已经出局" };
    const line = String(action || "").trim();
    if (!/^[A-Za-z]/.test(line)) return { error: "无效指令" };
    // a seat may revise its action until the turn resolves
    this.handleAction(seat, line, false, true);
    return { ok: true };
  }

  handleAction(seat, line, isAI, replace = false) {
    const s = this.seats[seat];
    if (!s || this.state !== "playing") return;
    if (s.action != null && !replace) return;
    const now = Date.now();
    if (replace) s.usedBank = 0;
    s.action = line;
    s.actedAt = now;
    if (!isAI) {
      const spent = now - this.turnStartedAt;
      const over = Math.max(0, spent - this.settings.stepMs);
      s.usedBank = Math.min(s.bankMs ?? this.settings.bankMs, (s.usedBank || 0) + over);
    }
    this.broadcastTurn();
    const pending = this.seats.filter((x) => this.isPlayingSeat(x) && x.action == null);
    if (!pending.length) this.resolveTurn();
  }

  resolveTurn() {
    if (this.state !== "playing" || !this.game) return;
    // guard: tidyClock/pace timers must never resolve the same turn twice
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const seq = this.turnSeq;
    const actions = this.seats.map((s) => s.action);
    const res = this.game.step((id) => {
      const a = actions[id];
      return a == null ? "WAIT" : a;
    });
    this.log.push({
      turn: res.turn,
      events: res.events,
      actions: this.seats.map((s) => ({
        seat: s.seat,
        name: s.name,
        avatar: s.avatar,
        kind: s.kind,
        line: actions[s.seat] || "WAIT",
        sanity: this.game.players[s.seat].sanity,
      })),
      entities: this.game.entityLines(),
      parsed: res.parsed,
    });

    if (res.events.length) for (const e of res.events) this.pushFeed(`T${res.turn} · ${e}`);

    this.broadcastTurn(true);

    const finished = this.game.turn > 200 || this.game.active().length === 0;
    if (finished) {
      this.finishGame();
      return;
    }

    // No human contributed to this turn: the board would jump from state to
    // state at CPU speed. Hold it on screen for the configured pace so a
    // spectator (or someone who just died) can actually follow the game.
    const humanActed = this.seats.some((s) => s.kind === "human" && s.action != null);
    const delay = humanActed ? 0 : Math.max(0, this.settings.paceMs);
    if (delay > 0) {
      this.paceTimer = setTimeout(() => {
        this.paceTimer = null;
        if (this.state === "playing") this.beginTurn();
      }, delay);
      return;
    }
    this.beginTurn();
  }

  finishGame() {
    this.clearPace();
    this.turnOpen = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopBots();

    const result = scoreGame(this.game);
    if (this.series) {
      for (let i = 0; i < 4; i++) this.series.totals[i] += result.points[i] || 0;
      this.series.results.push({
        index: this.series.index,
        map: this.game.map.name,
        turn: this.game.turn,
        order: result.order,
        points: result.points,
      });
    }
    this.replay = `${this.id}-${Date.now().toString(36)}`;

    const done = !this.series || this.series.index >= this.series.games;
    const watching = this.clients.size > 0 || this.seats.some((s) => s.kind === "human" && s.connected);
    const waitMs = done ? 0 : watching ? 30000 : 4000;

    this.state = done ? "finished" : "between";
    if (this.series) {
      this.series.done = done;
      this.series.nextAt = done ? null : Date.now() + waitMs;
    }
    // snapshot *after* nextAt is set, so the scoreboard can show its countdown
    const series = this.seriesSummary();

    this.emit("finished", { result, series, replay: this.replay });
    this.broadcast("finished", { result, series, replay: this.replay });
    this.touch();

    if (!done) {
      this.nextTimer = setTimeout(() => {
        this.nextTimer = null;
        if (this.state === "between") this.startGame();
      }, waitMs);
    }
  }

  seriesSummary() {
    const s = this.series || { games: 1, index: 1, results: [], totals: [0, 0, 0, 0], done: true };
    const rows = [0, 1, 2, 3]
      .map((seat) => ({
        seat,
        name: this.seats[seat].name,
        avatar: this.seats[seat].avatar,
        kind: this.seats[seat].kind,
        difficulty: this.seats[seat].difficulty,
        points: Math.round((s.totals[seat] || 0) * 100) / 100,
        wins: s.results.filter((r) => r.order[0]?.seat === seat).length,
      }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.seat - b.seat);
    rows.forEach((r, i) => (r.place = i + 1));
    return {
      total: s.games,
      index: s.index,
      done: !!s.done,
      nextAt: s.nextAt || null,
      results: s.results.map((r) => ({
        index: r.index,
        map: r.map,
        turn: r.turn,
        order: r.order.map((o) => ({
          seat: o.seat,
          place: o.place,
          points: o.points,
          sanity: o.sanity,
          alive: o.alive,
          deathTurn: o.deathTurn ?? null,
        })),
      })),
      rows,
    };
  }

  /** Bundle handed to the replay lab (same shape as the CodinGame bundles). */
  replayBundle() {
    const g = this.game;
    const ranking = g.standings().map((p) => p.id);
    return {
      kind: "arena",
      id: this.replay,
      name: this.name,
      map: g.map.name,
      seed: String(g.seed),
      grid: g.map.rows,
      params: [g.params.lonely, g.params.group, g.params.spawnTime, g.params.life],
      players: this.seats.map((s) => ({
        i: s.seat,
        name: s.name,
        agent: s.kind === "ai" ? `ai:${s.difficulty}` : null,
        me: false,
      })),
      turns: this.log.map((t) => ({
        t: t.turn,
        ent: t.entities,
        plays: t.actions.map((a) => ({
          a: { k: "MOVE", raw: a.line },
          s: [a.seat],
        })),
      })),
      scores: this.seats.map((s) => g.players[s.seat].score),
      ranking,
      tooltips: [],
      verified: true,
      meta: {
        ended: new Date().toISOString(),
        seats: this.seats.map((s) => ({ seat: s.seat, kind: s.kind, name: s.name, difficulty: s.difficulty })),
      },
    };
  }

  // ----------------------------------------------------------- clients ---
  addClient(client) {
    this.clients.add(client);
    client.send("state", this.stateFor(client));
    if (this.state !== "lobby") {
      client.send("snapshot", this.snapshotFor(client));
      if (this.state === "between" || this.state === "finished") {
        client.send("series", this.seriesSummary());
      }
    }
  }

  removeClient(client) {
    this.clients.delete(client);
    const seat = this.seats[client.seat];
    if (seat && seat.token === client.token) {
      seat.connected = false;
      this.touch();
    }
  }

  snapshotFor(client) {
    if (!this.game) return null;
    const snap = this.game.snapshot();
    const me = client && client.seat >= 0 ? client.seat : -1;
    const seat = this.seats[me];
    const pending = this.seats.filter((s) => this.isPlayingSeat(s) && s.action == null).map((s) => s.seat);
    return {
      ...snap,
      grid: this.game.map.rows,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        name: s.name,
        avatar: s.avatar,
        kind: s.kind,
        difficulty: s.difficulty,
      })),
      seat: me,
      isMyTurn: me >= 0 && this.state === "playing" && this.isPlayingSeat(this.seats[me] || {}),
      submitted: seat ? seat.action != null : false,
      lastAction: seat ? seat.action : null,
      pending,
      deadline: this.turnStartedAt + this.settings.stepMs + (me >= 0 ? this.bankLeft(this.seats[me] || {}) : 0),
      stepMs: this.settings.stepMs,
      bankMs: me >= 0 ? this.bankLeft(this.seats[me]) : 0,
      serverNow: Date.now(),
      feed: this.feedTail(40),
      series: this.seriesSummary(),
      standings: this.state === "finished" ? this.game.standings() : null,
    };
  }

  feedTail(n = 40) {
    return this._feed ? this._feed.slice(-n) : [];
  }

  pushFeed(line) {
    if (!this._feed) this._feed = [];
    this._feed.push({ at: Date.now(), text: line });
    if (this._feed.length > 200) this._feed.shift();
  }

  broadcastTurn(resolved = false) {
    for (const client of this.clients) {
      client.send(resolved ? "resolve" : "turn", this.snapshotFor(client));
    }
  }

  broadcast(event, payload) {
    for (const client of this.clients) client.send(event, payload);
  }

  close() {
    this.state = "closed";
    this.turnOpen = false;
    if (this.timer) clearInterval(this.timer);
    this.clearPace();
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.stopBots();
    for (const c of this.clients) {
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Placement points for one game: 1st +4, 2nd +3, 3rd +2, 4th +1.
 * Exact ties share the rank and the average of the points they occupy.
 */
function scoreGame(game) {
  const stand = game.standings();
  const key = (p) => (p.alive ? `A:${p.sanity}` : `D:${p.score}`);
  const order = [];
  let i = 0;
  while (i < stand.length) {
    let j = i;
    while (j + 1 < stand.length && key(stand[j + 1]) === key(stand[i])) j++;
    let sum = 0;
    for (let k = i; k <= j; k++) sum += 4 - k;
    const avg = Math.round((sum / (j - i + 1)) * 100) / 100;
    for (let k = i; k <= j; k++) {
      const p = stand[k];
      order.push({
        seat: p.id,
        place: i + 1,
        points: avg,
        alive: p.alive,
        sanity: p.sanity,
        deathTurn: p.alive ? null : p.score,
      });
    }
    i = j + 1;
  }
  const points = [0, 0, 0, 0];
  for (const o of order) points[o.seat] = o.points;
  return { order, points };
}
