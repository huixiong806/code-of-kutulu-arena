/* ==========================================================================
   Board renderer — shared by the live game and the replay player.
   Colours come from CSS custom properties, so theme switching is instant.
   ========================================================================== */

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const ENTITY = { EXPLORER: "E", WANDERER: "W", SLASHER: "S", EFFECT_SHELTER: "H", EFFECT_PLAN: "P", EFFECT_LIGHT: "L", EFFECT_YELL: "Y" };
const MINION_STATE = { 0: "spawn", 1: "wander", 2: "stalk", 3: "rush", 4: "stun" };

export function decodeEntities(lines) {
  const out = { explorers: [], minions: [], effects: [] };
  for (const line of lines || []) {
    const f = line.split(" ");
    const t = ENTITY[f[0]];
    if (!t) continue;
    const n = f.slice(1).map(Number);
    if (t === "E") out.explorers.push({ id: n[0], x: n[1], y: n[2], sanity: n[3], plans: n[4], lights: n[5] });
    else if (t === "W" || t === "S")
      out.minions.push({ type: t, id: n[0], x: n[1], y: n[2], timer: n[3], state: n[4], target: n[5] });
    else if (t === "H") out.effects.push({ type: "H", x: n[1], y: n[2], value: n[3] });
    else if (t === "P" || t === "L") out.effects.push({ type: t, x: n[1], y: n[2], value: n[3], owner: n[4] });
    else if (t === "Y") out.effects.push({ type: "Y", x: -1, y: -1, value: n[3], owner: n[4], receiver: n[5] });
  }
  return out;
}

export class Board {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;
    this.grid = [];
    this.W = 0;
    this.H = 0;
    this.players = [];
    this.me = -1;
    this.state = null;
    this.prev = null;
    this.animStart = 0;
    this.animMs = 260;
    this.hover = null;
    this.path = null;
    this.colors = null;
    this.shake = 0;
    this.onCell = null;
    this.onHover = null;
    this._bind();
    this._resizeObserver = new ResizeObserver(() => this.render());
    this._resizeObserver.observe(canvas);
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("mousemove", (e) => {
      const cell = this._cellAt(e);
      const changed = !cell || !this.hover || cell.x !== this.hover.x || cell.y !== this.hover.y;
      this.hover = cell;
      if (changed) {
        this.path = cell && this.opts.pathFor ? this.opts.pathFor(cell.x, cell.y) : null;
        if (this.onHover) this.onHover(cell);
        this.render();
      }
    });
    c.addEventListener("mouseleave", () => {
      this.hover = null;
      this.path = null;
      this.render();
    });
    c.addEventListener("click", (e) => {
      const cell = this._cellAt(e);
      if (cell && this.onCell) this.onCell(cell.x, cell.y);
    });
  }

  _cellAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const m = this._measure();
    const x = Math.floor((e.clientX - r.left - m.ox) / m.cs);
    const y = Math.floor((e.clientY - r.top - m.oy) / m.cs);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
    return { x, y };
  }

  /** Re-read the theme palette (call on theme change). */
  refreshTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.colors = {
      bg1: v("--cv-bg1"),
      bg2: v("--cv-bg2"),
      floor: v("--cv-floor"),
      floor2: v("--cv-floor2"),
      grid: v("--cv-grid"),
      wall: v("--cv-wall"),
      wall2: v("--cv-wall2"),
      wallHi: v("--cv-wall-hi"),
      ink: v("--cv-ink"),
      spawn: v("--cv-spawn"),
      shelter: v("--cv-shelter"),
      walkable: v("--cv-walkable"),
      accent: v("--accent"),
      accent2: v("--accent-2"),
      muted: v("--muted"),
      seats: [v("--p0"), v("--p1"), v("--p2"), v("--p3")],
    };
    this.render();
  }

  setGame({ grid, players, me }) {
    this.grid = grid;
    this.H = grid.length;
    this.W = grid[0].length;
    this.players = players || [];
    this.me = me ?? -1;
    this.state = null;
    this.prev = null;
    this.path = null;
    if (!this.colors) this.refreshTheme();
    this.render();
  }

  setState(entities, animate = true) {
    const next = decodeEntities(entities);
    for (const e of next.explorers) e.alive = true;
    if (animate && this.state) {
      this.prev = this.state;
      this.animStart = performance.now();
    } else {
      this.prev = null;
    }
    this.state = next;
    this.render();
  }

  _measure() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const pad = 26;
    const cs = Math.min((w - pad * 2) / this.W, (h - pad * 2) / this.H);
    return { w, h, cs, ox: w / 2 - (this.W * cs) / 2, oy: h / 2 - (this.H * cs) / 2 };
  }

  _ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  _pos(entity, key, m, k) {
    if (!this.prev) return { x: entity.x, y: entity.y };
    const prev = this.prev[key].find((e) => e.id === entity.id && e.type === entity.type);
    if (!prev) return { x: entity.x, y: entity.y }; // fade-in
    return { x: prev.x + (entity.x - prev.x) * k, y: prev.y + (entity.y - prev.y) * k };
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.W) return;
    const dpr = window.devicePixelRatio || 1;
    const m = this._measure();
    if (this.canvas.width !== Math.round(m.w * dpr) || this.canvas.height !== Math.round(m.h * dpr)) {
      this.canvas.width = Math.round(m.w * dpr);
      this.canvas.height = Math.round(m.h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.h);

    const animT = this.prev ? Math.min(1, (performance.now() - this.animStart) / this.animMs) : 1;
    const k = this._ease(animT);

    this._background(ctx, m);
    this._gridLayer(ctx, m);
    this._hoverLayer(ctx, m);
    if (this.state) {
      this._effects(ctx, m, k);
      this._minions(ctx, m, k);
      this._explorers(ctx, m, k);
      this._floating(ctx, m, k);
    }
    if (this.state && this.prev && animT < 1) requestAnimationFrame(() => this.render());
  }

  _background(ctx, m) {
    const g = ctx.createRadialGradient(m.w * 0.5, m.h * 0.34, 40, m.w * 0.5, m.h * 0.5, Math.max(m.w, m.h) * 0.9);
    g.addColorStop(0, this.colors.bg1);
    g.addColorStop(1, this.colors.bg2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, m.w, m.h);
  }

  _gridLayer(ctx, m) {
    const { cs, ox, oy } = m;
    const C = this.colors;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const ch = this.grid[y][x];
        const px = ox + x * cs;
        const py = oy + y * cs;
        if (ch === "#") continue;
        ctx.fillStyle = (x + y) % 2 ? C.floor : C.floor2;
        ctx.fillRect(px, py, cs, cs);
        ctx.fillStyle = C.walkable;
        ctx.fillRect(px + 1, py + 1, cs - 2, cs - 2);
      }
    }
    // walls
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        if (this.grid[y][x] !== "#") continue;
        const px = ox + x * cs;
        const py = oy + y * cs;
        const g = ctx.createLinearGradient(px, py, px, py + cs);
        g.addColorStop(0, C.wall);
        g.addColorStop(1, C.wall2);
        ctx.fillStyle = g;
        this._round(ctx, px + 0.6, py + 0.6, cs - 1.2, cs - 1.2, Math.max(2, cs * 0.16));
        ctx.fill();
        ctx.fillStyle = C.wallHi;
        ctx.fillRect(px + 2, py + 2, cs - 4, Math.max(1, cs * 0.09));
      }
    }
    // grid lines
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.W; x++) {
      ctx.moveTo(Math.round(ox + x * cs) + 0.5, oy);
      ctx.lineTo(Math.round(ox + x * cs) + 0.5, oy + this.H * cs);
    }
    for (let y = 0; y <= this.H; y++) {
      ctx.moveTo(ox, Math.round(oy + y * cs) + 0.5);
      ctx.lineTo(ox + this.W * cs, Math.round(oy + y * cs) + 0.5);
    }
    ctx.stroke();

    // board frame: a thin lit edge so the play area reads as a plate
    const fx = ox - 6;
    const fy = oy - 6;
    const fw = this.W * cs + 12;
    const fh = this.H * cs + 12;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 18;
    ctx.strokeStyle = this._alpha(this.colors.ink, 0.14);
    ctx.lineWidth = 1;
    this._round(ctx, fx, fy, fw, fh, 10);
    ctx.stroke();
    ctx.restore();

    // static markers
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const ch = this.grid[y][x];
        const cx = ox + (x + 0.5) * cs;
        const cy = oy + (y + 0.5) * cs;
        if (ch === "w") {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 0.85);
          g.addColorStop(0, this._alpha(C.spawn, 0.22));
          g.addColorStop(1, this._alpha(C.spawn, 0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - cs * 0.85, cy - cs * 0.85, cs * 1.7, cs * 1.7);
          ctx.strokeStyle = this._alpha(C.spawn, 0.55);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(cx, cy, cs * 0.24, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = this._alpha(C.spawn, 0.7);
          ctx.beginPath();
          ctx.arc(cx, cy, cs * 0.07, 0, Math.PI * 2);
          ctx.fill();
        } else if (ch === "U") {
          const r = cs * 0.29;
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i - Math.PI / 6;
            const px = cx + Math.cos(a) * r;
            const py = cy + Math.sin(a) * r;
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = this._alpha(C.shelter, 0.14);
          ctx.fill();
          ctx.strokeStyle = this._alpha(C.shelter, 0.55);
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
    }
  }

  _hoverLayer(ctx, m) {
    if (!this.hover) return;
    const { cs, ox, oy } = m;
    const cell = this.grid[this.hover.y][this.hover.x];
    const px = ox + this.hover.x * cs;
    const py = oy + this.hover.y * cs;
    ctx.strokeStyle = this._alpha(this.colors.accent, 0.75);
    ctx.lineWidth = 1.6;
    this._round(ctx, px + 1, py + 1, cs - 2, cs - 2, 5);
    ctx.stroke();
    if (this.path && this.path.length > 1) {
      ctx.strokeStyle = this._alpha(this.colors.accent, 0.5);
      ctx.lineWidth = Math.max(1.4, cs * 0.05);
      ctx.setLineDash([cs * 0.16, cs * 0.14]);
      ctx.beginPath();
      ctx.moveTo(ox + (this.path[0].x + 0.5) * cs, oy + (this.path[0].y + 0.5) * cs);
      for (const p of this.path.slice(1)) ctx.lineTo(ox + (p.x + 0.5) * cs, oy + (p.y + 0.5) * cs);
      ctx.stroke();
      ctx.setLineDash([]);
      const end = this.path[this.path.length - 1];
      ctx.strokeStyle = this._alpha(this.colors.accent, 0.9);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const ex = ox + (end.x + 0.5) * cs;
      const ey = oy + (end.y + 0.5) * cs;
      ctx.moveTo(ex - cs * 0.16, ey - cs * 0.16);
      ctx.lineTo(ex + cs * 0.16, ey + cs * 0.16);
      ctx.moveTo(ex + cs * 0.16, ey - cs * 0.16);
      ctx.lineTo(ex - cs * 0.16, ey + cs * 0.16);
      ctx.stroke();
    }
    if (cell === "#") {
      ctx.fillStyle = this._alpha("#000", 0.12);
      ctx.fillRect(px, py, cs, cs);
    }
  }

  _effects(ctx, m, k) {
    const { cs, ox, oy } = m;
    const C = this.colors;
    for (const e of this.state.effects) {
      if (e.type === "P") {
        const cx = ox + (e.x + 0.5) * cs;
        const cy = oy + (e.y + 0.5) * cs;
        const r = 2.6 * cs;
        const g = ctx.createRadialGradient(cx, cy, cs * 0.2, cx, cy, r);
        g.addColorStop(0, "rgba(110,231,168,0.26)");
        g.addColorStop(1, "rgba(110,231,168,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(110,231,168,0.5)";
        ctx.setLineDash([4, 5]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (e.type === "L") {
        const cx = ox + (e.x + 0.5) * cs;
        const cy = oy + (e.y + 0.5) * cs;
        const r = 5.6 * cs;
        const g = ctx.createRadialGradient(cx, cy, cs * 0.4, cx, cy, r);
        g.addColorStop(0, "rgba(94,200,247,0.15)");
        g.addColorStop(1, "rgba(94,200,247,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(94,200,247,0.3)";
        ctx.setLineDash([2, 7]);
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (e.type === "Y") {
        const recv = this.state.explorers.find((p) => p.id === e.receiver);
        if (!recv) continue;
        const rx = ox + (recv.x + 0.5) * cs;
        const ry = oy + (recv.y + 0.5) * cs;
        ctx.strokeStyle = "rgba(255,122,89,0.8)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(rx, ry, cs * 0.44, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,122,89,0.9)";
        ctx.font = `700 ${Math.max(8, cs * 0.24)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("YELL", rx, ry - cs * 0.56);
      } else if (e.type === "H") {
        const cx = ox + (e.x + 0.5) * cs;
        const cy = oy + (e.y + 0.5) * cs;
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, e.value / 10));
        ctx.strokeStyle = this._alpha(C.shelter, 0.9);
        ctx.lineWidth = Math.max(1.6, cs * 0.05);
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.lineCap = "butt";
        if (cs > 22) {
          ctx.fillStyle = this._alpha(C.shelter, 0.95);
          ctx.font = `650 ${Math.max(7, cs * 0.18)}px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(e.value), cx, cy);
        }
      }
    }
  }

  _minions(ctx, m, k) {
    const { cs, ox, oy } = m;
    const alphaFor = (ent) => {
      if (!this.prev) return 1;
      const found = this.prev.minions.find((p) => p.id === ent.id && p.type === ent.type);
      return found ? 1 : k;
    };
    for (const g of this.state.minions) {
      const p = this._pos(g, "minions", m, k);
      const x = ox + (p.x + 0.5) * cs;
      const y = oy + (p.y + 0.5) * cs;
      const a = alphaFor(g);
      ctx.globalAlpha = a;
      if (g.type === "W") this._wanderer(ctx, x, y, cs, g);
      else this._slasher(ctx, x, y, cs, g);
      ctx.globalAlpha = 1;
    }
  }

  _wanderer(ctx, x, y, cs, g) {
    const r = cs * 0.24;
    if (g.state === 0) {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(200,210,255,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = this._alpha(this.colors.ink, 0.75);
      ctx.font = `700 ${Math.max(8, cs * 0.26)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(g.timer), x, y);
      return;
    }
    const bob = Math.sin(performance.now() / 520 + g.id) * cs * 0.02;
    ctx.beginPath();
    ctx.arc(x, y + bob - r * 0.25, r, Math.PI, 0);
    ctx.lineTo(x + r, y + bob + r * 0.55);
    for (let i = 0; i < 3; i++) {
      ctx.quadraticCurveTo(x + r - (i * 2 + 1) * (r / 3), y + bob + r * 0.15, x + r - (i + 1) * (r * 2 / 3), y + bob + r * 0.55);
    }
    ctx.closePath();
    const gd = ctx.createLinearGradient(x, y - r, x, y + r);
    gd.addColorStop(0, "rgba(226,232,255,0.96)");
    gd.addColorStop(1, "rgba(130,140,190,0.72)");
    ctx.fillStyle = gd;
    ctx.fill();
    ctx.strokeStyle = "rgba(240,245,255,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(20,24,40,0.8)";
    ctx.beginPath();
    ctx.arc(x - r * 0.34, y + bob - r * 0.15, r * 0.14, 0, Math.PI * 2);
    ctx.arc(x + r * 0.34, y + bob - r * 0.15, r * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }

  _slasher(ctx, x, y, cs, g) {
    const r = cs * 0.3;
    if (g.state === 0) {
      ctx.beginPath();
      ctx.arc(x, y, cs * 0.26, 0, Math.PI * 2);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(255,190,205,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,210,225,0.85)";
      ctx.font = `700 ${Math.max(8, cs * 0.26)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(g.timer), x, y);
      return;
    }
    if (g.state === 3) {
      const gd = ctx.createRadialGradient(x, y, 0, x, y, cs * 0.8);
      gd.addColorStop(0, "rgba(255,70,100,0.45)");
      gd.addColorStop(1, "rgba(255,70,100,0)");
      ctx.fillStyle = gd;
      ctx.fillRect(x - cs * 0.8, y - cs * 0.8, cs * 1.6, cs * 1.6);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(performance.now() / 700 + g.id) * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.95, -r * 0.1, r * 0.25, r * 0.9);
    ctx.lineTo(0, r * 0.45);
    ctx.lineTo(-r * 0.25, r * 0.9);
    ctx.quadraticCurveTo(-r * 0.95, -r * 0.1, 0, -r);
    ctx.closePath();
    const gd = ctx.createLinearGradient(0, -r, 0, r);
    gd.addColorStop(0, g.state === 4 ? "#8a92a6" : "#ff7d95");
    gd.addColorStop(1, g.state === 4 ? "#3f4554" : "rgba(150,45,70,0.95)");
    ctx.fillStyle = gd;
    ctx.globalAlpha *= g.state === 4 ? 0.6 : 1;
    ctx.fill();
    ctx.strokeStyle = g.state === 3 ? "rgba(255,150,170,0.95)" : "rgba(255,200,215,0.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  _explorers(ctx, m, k) {
    const { cs, ox, oy } = m;
    // spread co-located explorers
    const groups = new Map();
    for (const p of this.state.explorers) {
      const key = p.x + "," + p.y;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p.id);
    }
    const OFF = {
      2: [[-0.17, 0], [0.17, 0]],
      3: [[0, -0.17], [-0.16, 0.12], [0.16, 0.12]],
      4: [[-0.16, -0.13], [0.16, -0.13], [-0.16, 0.13], [0.16, 0.13]],
    };
    for (const p of this.state.explorers) {
      const pos = this._pos(p, "explorers", m, k);
      const grp = groups.get(p.x + "," + p.y) || [p.id];
      const off = grp.length > 1 ? OFF[Math.min(grp.length, 4)][grp.indexOf(p.id) % Math.min(grp.length, 4)] : [0, 0];
      const x = ox + (pos.x + 0.5 + off[0]) * cs;
      const y = oy + (pos.y + 0.5 + off[1]) * cs;
      const isMe = p.id === this.me;
      const color = this.colors.seats[p.id] || "#fff";
      // names are dropped when a neighbour is adjacent: the labels would collide
      const near = this.state.explorers.some(
        (o) => o.id !== p.id && Math.abs(o.x - p.x) <= 1 && Math.abs(o.y - p.y) <= 1
      );
      this._explorer(ctx, p, x, y, cs, color, isMe, grp.length, near);
    }
  }

  _explorer(ctx, p, x, y, cs, color, isMe, crowd, near) {
    const r = cs * 0.27;
    // shadow
    ctx.beginPath();
    ctx.ellipse(x, y + cs * 0.27, cs * 0.24, cs * 0.09, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();

    if (isMe) {
      const pulse = 0.45 + 0.3 * Math.sin(performance.now() / 460);
      ctx.beginPath();
      ctx.arc(x, y, r * 1.7, 0, Math.PI * 2);
      ctx.strokeStyle = this._alpha(this.colors.accent, pulse);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2);
    glow.addColorStop(0, this._alpha(color, 0.3));
    glow.addColorStop(1, this._alpha(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.fill();

    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, color);
    g.addColorStop(1, this._shade(color, -0.35));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, cs * 0.045);
    ctx.strokeStyle = "rgba(8,10,16,0.85)";
    ctx.stroke();

    const kk = Math.max(0, Math.min(1, p.sanity / 250));
    ctx.beginPath();
    ctx.arc(x, y, r * 1.17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * kk);
    ctx.strokeStyle = this._sanColor(p.sanity);
    ctx.lineWidth = Math.max(1.6, cs * 0.06);
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";

    ctx.fillStyle = "rgba(8,10,16,0.9)";
    ctx.font = `700 ${Math.max(9, cs * 0.3)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(p.id), x, y + 0.5);

    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 3;
    ctx.fillStyle = this._alpha(this.colors.ink, 0.95);
    ctx.font = `650 ${Math.max(8, cs * 0.23)}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(String(p.sanity), x, y + cs * 0.33);

    if (cs >= 30 && crowd < 2 && !near) {
      const name = (this.players[p.id] && this.players[p.id].name) || "";
      ctx.font = `500 ${Math.max(7, cs * 0.17)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = this._alpha(this.colors.muted, 0.85);
      ctx.fillText(name.slice(0, 6), x, y + cs * 0.55);
    }
    ctx.shadowBlur = 0;

    const dots = [];
    for (let i = 0; i < p.plans; i++) dots.push("#6ee7a8");
    for (let i = 0; i < p.lights; i++) dots.push("#5ec8f7");
    const dr = Math.max(1.3, cs * 0.05);
    dots.forEach((c, i) => {
      const px = x - (dots.length - 1) * dr * 1.9 + i * dr * 3.8;
      const py = y - r * 1.45;
      ctx.beginPath();
      ctx.arc(px, py, dr, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    });
  }

  _floating(ctx, m, k) {
    if (!this.prev || k >= 1) return;
    const { cs, ox, oy } = m;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of this.state.explorers) {
      const before = this.prev.explorers.find((e) => e.id === p.id);
      if (!before) continue;
      const delta = p.sanity - before.sanity;
      if (Math.abs(delta) < 3) continue;
      const pos = this._pos(p, "explorers", m, k);
      const x = ox + (pos.x + 0.5) * cs;
      const y = oy + (pos.y + 0.5) * cs - cs * 0.75 - k * cs * 0.3;
      ctx.font = `700 ${Math.max(10, cs * 0.3)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = delta > 0 ? "rgba(110,231,168,0.95)" : "rgba(255,107,129,0.95)";
      ctx.fillText(`${delta > 0 ? "+" : ""}${delta}`, x, y);
    }
  }

  // ------------------------------------------------------------- helpers
  _sanColor(s) {
    const t = Math.max(0, Math.min(1, s / 250));
    const hue = 4 + 128 * t;
    return `hsl(${hue} 72% 52%)`;
  }

  _alpha(color, a) {
    const c = String(color).trim();
    if (c.startsWith("#")) {
      const n = parseInt(c.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    if (c.startsWith("rgb(")) return c.replace("rgb(", "rgba(").replace(")", `,${a})`);
    return c;
  }

  _shade(hex, amt) {
    const n = parseInt(String(hex).slice(1), 16);
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return `rgb(${clamp(((n >> 16) & 255) + 255 * amt)},${clamp(((n >> 8) & 255) + 255 * amt)},${clamp((n & 255) + 255 * amt)})`;
  }

  _round(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

/** Shortest path with the same tie-break as the referee (A*, stable order). */
export function pathBetween(grid, from, to) {
  const H = grid.length;
  const W = grid[0].length;
  const walk = (x, y) => x >= 0 && y >= 0 && x < W && y < H && grid[y][x] !== "#";
  if (!walk(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [from];
  const open = [{ x: from.x, y: from.y, cum: 0, f: 1, prev: null }];
  const closed = new Uint8Array(W * H);
  while (open.length) {
    const v = open.shift();
    if (v.x === to.x && v.y === to.y) {
      const path = [];
      for (let it = v; it; it = it.prev) path.unshift({ x: it.x, y: it.y });
      return path;
    }
    if (closed[v.y * W + v.x]) continue;
    closed[v.y * W + v.x] = 1;
    for (const [dx, dy] of DIRS) {
      const nx = v.x + dx;
      const ny = v.y + dy;
      if (!walk(nx, ny) || closed[ny * W + nx]) continue;
      open.push({ x: nx, y: ny, cum: v.cum + 1, f: v.cum + 2, prev: v });
    }
    open.sort((a, b) => a.f - b.f);
  }
  return null;
}
