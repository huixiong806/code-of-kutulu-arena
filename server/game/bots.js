/**
 * AI seats.
 *
 * The bots in ../../build are the real CodinGame submissions: plain console
 * programs that read the turn input on stdin and print one action line.  They
 * are spawned as child processes, one per AI seat, and kept alive for the whole
 * game (they may keep internal state between turns).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARENA = path.resolve(HERE, "../..");
const ROOT = path.resolve(ARENA, "..");

/**
 * Difficulty ladder.  Four real submissions picked so that the measured
 * head-to-head win rate between neighbouring tiers is roughly even
 * (~56% / 68% / 60%, 40-game seat-rotated round robins — see tools/roundrobin.mjs).
 *
 * `file` is the base name: the arena looks for arena/bots/<file><exe> first and
 * falls back to ../build/<file><exe>.
 */
export const DIFFICULTIES = {
  novice: {
    label: "入门",
    file: "baseline_rank212",
    desc: "最早的手写启发式（无搜索、无网络）",
  },
  easy: {
    label: "简单",
    file: "kutulu_v2",
    desc: "第一代搜索版：3 层 beam + 两种对手假设",
  },
  medium: {
    label: "中等",
    file: "kutulu_wide",
    desc: "加宽 beam 的搜索版（wide）",
  },
  hard: {
    label: "困难",
    file: "casper_c23_v32",
    desc: "PUCT + 网络的 c23-v32 版",
  },
  expert: {
    label: "极难",
    file: "clawd_r4_fast2",
    desc: "PUCT + 9k 网络，22ms 硬截断（r4-fast2）",
  },
};

const EXE = process.platform === "win32" ? ".exe" : "";

export function difficultyInfo(key) {
  const d = DIFFICULTIES[key] || DIFFICULTIES.medium;
  return {
    key: DIFFICULTIES[key] ? key : "medium",
    ...d,
    exe: d.file + EXE,
    avatar: [...d.label][0],
  };
}

export function botPath(key) {
  const d = DIFFICULTIES[key] || DIFFICULTIES.medium;
  const local = path.join(ARENA, "bots", d.file + EXE);
  return fs.existsSync(local) ? local : path.join(ROOT, "build", d.file + EXE);
}

export function availableBots() {
  return Object.keys(DIFFICULTIES)
    .filter((k) => hasBot(k))
    .map((k) => ({ ...difficultyInfo(k), path: botPath(k), available: true }));
}

export function hasBot(key) {
  if (!DIFFICULTIES[key]) return false;
  return fs.existsSync(botPath(key));
}

/**
 * Pick a tier that actually has a binary on disk. A fresh clone may ship only
 * one bot, so asking for "expert" has to degrade to whatever is installed
 * instead of leaving the seat dead.
 */
export function resolveDifficulty(key) {
  if (DIFFICULTIES[key] && hasBot(key)) return key;
  const order = ["novice", "easy", "medium", "hard", "expert"];
  return order.find((k) => hasBot(k)) || "novice";
}

/** A single bot process wired for line-oriented play. */
export class BotProcess {
  constructor(key, opts = {}) {
    this.key = key;
    // a difficulty key, or an explicit path for ad-hoc matches
    this.exe = /[\\/]/.test(key) ? key : botPath(key);
    this.timeoutMs = opts.timeoutMs || 1500;
    this.proc = null;
    this.buf = "";
    this.lines = [];
    this.waiter = null;
    this.dead = false;
    this.errors = [];
  }

  start() {
    if (!fs.existsSync(this.exe)) throw new Error(`bot not found: ${this.exe}`);
    this.proc = spawn(this.exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (d) => {
      const line = String(d).trim();
      if (line) this.errors.push(line);
      if (this.errors.length > 40) this.errors.shift();
    });
    this.proc.on("exit", () => {
      this.dead = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(null);
      }
    });
    this.proc.on("error", () => {
      this.dead = true;
    });
    return this;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(line);
      } else {
        this.lines.push(line);
      }
    }
  }

  /** Send a block of lines (already newline-free) for one turn. */
  writeTurn(lines) {
    if (!this.proc || this.dead) return;
    try {
      this.proc.stdin.write(lines.join("\n") + "\n");
    } catch {
      this.dead = true;
    }
  }

  /** Resolve with the next output line, or null on timeout / crash. */
  readLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === entry) this.waiter = null;
        resolve(null);
      }, this.timeoutMs);
      const entry = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      };
      this.waiter = entry;
    });
  }

  async ask(lines) {
    this.writeTurn(lines);
    return this.readLine();
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.dead = true;
  }
}
