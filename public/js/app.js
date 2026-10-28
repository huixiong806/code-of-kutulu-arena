/* ==========================================================================
   Kutulu Arena client
   ========================================================================== */
import { Board, decodeEntities, pathBetween } from "./board.js";
import { RULES_HTML } from "./rules.js";

const $ = (id) => document.getElementById(id);
const SEAT_VARS = ["--p0", "--p1", "--p2", "--p3"];
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

const state = {
  me: store.get("arena:me", null),
  theme: store.get("arena:theme", "obsidian"),
  room: null, // {id, token, seat}
  snapshot: null,
  es: null,
  clockOffset: 0,
  replay: null,
  rp: { idx: 0, playing: false, speed: 1, last: 0, acc: 0 },
  bots: null,   // null = 还没拿到 /api/bots；[] = 拿到了但没有可用程序
  grid: null,
};

const board = new Board($("board"), {
  pathFor(x, y) {
    const me = myExplorer();
    if (!me || !state.snapshot || !state.snapshot.isMyTurn) return null;
    return pathBetween(currentGrid(), { x: me.x, y: me.y }, { x, y });
  },
});
board.onCell = (x, y) => {
  if (!state.snapshot || !state.snapshot.isMyTurn) return;
  const g = currentGrid();
  if (!g[y] || g[y][x] === "#") {
    toast("那边是墙");
    return;
  }
  submit(`MOVE ${x} ${y}`);
};
const replayBoard = new Board($("replayBoard"), {});

// ------------------------------------------------------------------ utils
function toast(msg, ms = 1800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function seatColor(i) {
  return getComputedStyle(document.documentElement).getPropertyValue(SEAT_VARS[i] || "--p0").trim() || "#888";
}

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const FALLBACK_DIFFS = [
  { key: "novice", label: "入门" },
  { key: "easy", label: "简单" },
  { key: "medium", label: "中等" },
  { key: "hard", label: "困难" },
  { key: "expert", label: "极难" },
];

function difficulties() {
  return Array.isArray(state.bots) ? state.bots : FALLBACK_DIFFS;
}

function difficultyLabel(key) {
  return difficulties().find((d) => d.key === key)?.label || key;
}

// ------------------------------------------------------------------ rules
async function renderLadder() {
  const box = document.getElementById("ladderTable");
  if (!box) return;
  try {
    const res = await fetch("/api/ladder");
    if (!res.ok) {
      box.remove();
      return;
    }
    const d = await res.json();
    const when = new Date(d.generatedAt).toLocaleString("zh-CN");
    box.className = "ladder-slot";
    box.innerHTML = `
      <table class="score-table ladder-table">
        <tr><th>档位</th><th>bot</th><th class="pts">出场</th><th class="pts">1 位率</th><th class="pts">4 位率</th><th class="pts">平均名次</th></tr>
        ${d.rows
          .map(
            (r) => `<tr>
              <td>${escapeHtml(r.label)}</td>
              <td><code>${escapeHtml(r.file)}</code></td>
              <td class="pts">${r.played}</td>
              <td class="pts p1">${r.firstRate}%</td>
              <td class="pts">${r.fourthRate}%</td>
              <td class="pts">${r.avgPlace.toFixed(2)}</td>
            </tr>`
          )
          .join("")}
      </table>
      <p class="hint">${d.finished} 局有效对局 · ${d.workers} 路并行 · 统计时间 ${when}</p>`;
  } catch {
    box.remove();
  }
}

function openRules(anchor) {
  const dlg = $("rulesDialog");
  if (!$("rulesContent").dataset.ready) {
    $("rulesContent").innerHTML = RULES_HTML;
    $("rulesContent").dataset.ready = "1";
    renderLadder();
  }
  dlg.showModal();
  if (anchor) {
    const el = $("rulesContent").querySelector(anchor);
    if (el) el.scrollIntoView({ block: "start" });
  } else {
    $("rulesContent").scrollTop = 0;
  }
}
$("rulesBtn").onclick = () => openRules();
$("rulesBtnHome").onclick = () => openRules();
$("rulesClose").onclick = () => $("rulesDialog").close();
$("rulesDialog").addEventListener("click", (e) => {
  // click on the backdrop closes
  if (e.target === $("rulesDialog")) $("rulesDialog").close();
});
$("rulesContent")?.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#r-']");
  if (!a) return;
  e.preventDefault();
  const el = $("rulesContent").querySelector(a.getAttribute("href"));
  if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
});

// ------------------------------------------------------------------ theme
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  document.querySelectorAll(".theme-dot").forEach((b) => b.classList.toggle("on", b.dataset.theme === name));
  store.set("arena:theme", name);
  state.theme = name;
  requestAnimationFrame(() => {
    board.refreshTheme();
    replayBoard.refreshTheme();
  });
}
document.querySelectorAll(".theme-dot").forEach((b) => {
  b.onclick = () => applyTheme(b.dataset.theme);
});

// --------------------------------------------------------------- identity
function setMe(name) {
  const clean = String(name || "").trim().slice(0, 16) || "无名探索者";
  const first = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(clean)][0];
  const avatar = (first?.segment || "?").toUpperCase();
  state.me = { name: clean, avatar };
  store.set("arena:me", state.me);
  $("meName").textContent = clean;
  $("meAvatar").textContent = avatar;
}

$("meChip").onclick = () => {
  $("nickInput").value = state.me?.name || "";
  $("nameDialog").showModal();
};
$("nameDialog").addEventListener("close", () => {
  if ($("nameDialog").returnValue === "ok") {
    const v = $("nickInput").value.trim();
    if (v) setMe(v);
  }
});

// ------------------------------------------------------------------ views
function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "home") loadHome();
}

// ------------------------------------------------------------------- home
async function loadHome() {
  try {
    const [rooms, replays] = await Promise.all([api("/api/rooms"), api("/api/replays")]);
    const list = $("roomList");
    if (!rooms.rooms.length) {
      list.innerHTML = `<div class="empty">还没有房间，来创建一间吧。</div>`;
    } else {
      list.innerHTML = rooms.rooms
        .map((r) => {
          const people = r.seated.filter(Boolean).length;
          const isLive = r.state === "playing";
          return `<div class="room-row" data-room="${r.id}">
            <div>
              <b>${escapeHtml(r.name)}</b>
              <div class="meta">${r.seated.map((s) => (s ? s.avatar : "·")).join(" ")} · ${people}/4 · 步时 ${(r.settings.stepMs / 1000).toFixed(1)}s</div>
            </div>
            <span class="badge ${isLive ? "live" : ""}">${isLive ? "对战中" : "等待中"}</span>
          </div>`;
        })
        .join("");
      list.querySelectorAll(".room-row").forEach((el) => {
        el.onclick = () => (location.hash = `#/room/${el.dataset.room}`);
      });
    }
    $("roomCount").textContent = `${rooms.rooms.length} 间`;

    const rp = $("replayList");
    if (!replays.replays.length) {
      rp.innerHTML = `<div class="empty">打完一局就会出现在这里。</div>`;
    } else {
      rp.innerHTML = replays.replays
        .slice(0, 8)
        .map(
          (r) => `<div class="replay-row" data-replay="${r.id}">
            <span>${escapeHtml(r.map)}<span class="m"> · ${r.turns}T</span></span>
            <span class="m">${new Date(r.ended).toLocaleDateString("zh-CN")}</span>
          </div>`
        )
        .join("");
      rp.querySelectorAll(".replay-row").forEach((el) => {
        el.onclick = () => (location.hash = `#/replay/${el.dataset.replay}`);
      });
    }
  } catch (e) {
    toast(e.message);
  }
}

$("refreshRooms").onclick = loadHome;
$("quickBtn").onclick = async () => {
  if (!state.me) return $("nameDialog").showModal();
  try {
    const r = await api("/api/rooms", { name: "快速对局", nickname: state.me.name, quick: true });
    store.set(`arena:room:${r.id}`, { token: r.token, seat: r.seat });
    location.hash = `#/room/${r.id}`;
  } catch (e) {
    toast(e.message);
  }
};
$("createBtn").onclick = () => {
  if (!state.me) return $("nameDialog").showModal();
  $("createDialog").showModal();
};
$("doCreate").onclick = async (ev) => {
  ev.preventDefault();
  const name = $("newRoomName").value.trim() || "库图鲁的墓穴";
  try {
    const r = await api("/api/rooms", {
      name,
      nickname: state.me.name,
      stepMs: Math.round(Number($("newStep").value) * 1000),
      bankMs: Math.round(Number($("newBank").value) * 1000),
      games: Number($("newGames").value) || 1,
    });
    store.set(`arena:room:${r.id}`, { token: r.token, seat: r.seat });
    $("createDialog").close();
    location.hash = `#/room/${r.id}`;
  } catch (e) {
    toast(e.message);
  }
};

// ------------------------------------------------------------------- room
const room = { info: null };

async function enterRoom(code) {
  if (!state.me) {
    $("nickInput").value = "";
    $("nameDialog").showModal();
    $("nameDialog").addEventListener(
      "close",
      () => {
        if (state.me) enterRoom(code);
      },
      { once: true }
    );
    return;
  }
  const saved = store.get(`arena:room:${code}`, null);
  try {
    const joined = await api(`/api/rooms/${code}/join`, { nickname: state.me.name, token: saved?.token });
    store.set(`arena:room:${code}`, { token: joined.token, seat: joined.seat });
    state.room = { id: code, token: joined.token, seat: joined.seat };
    if (joined.spectator) toast("对局已开始，你以观战身份加入");
    connectEvents(code, joined.token);
    show("room");
    $("roomCode").textContent = code;
    setupRoomControls();
  } catch (e) {
    toast(e.message);
    location.hash = "#/";
  }
}

function connectEvents(code, token) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/rooms/${code}/events?token=${encodeURIComponent(token)}`);
  state.es = es;
  es.addEventListener("state", (ev) => {
    room.info = JSON.parse(ev.data);
    renderRoom();
  });
  es.addEventListener("turn", (ev) => applySnapshot(JSON.parse(ev.data), false));
  es.addEventListener("resolve", (ev) => applySnapshot(JSON.parse(ev.data), true));
  es.addEventListener("finished", (ev) => showResult(JSON.parse(ev.data)));
  es.addEventListener("series", (ev) => {
    const series = JSON.parse(ev.data);
    // reconnect / late join in the middle of the scoreboard
    const last = series.results && series.results[series.results.length - 1];
    if (!state.lastResult && last) {
      showResult({ result: { order: last.order }, series, replay: null });
    } else if (state.lastResult) {
      showResult({ ...state.lastResult, series });
    }
  });
}

function setupRoomControls() {
  $("copyInvite").onclick = async () => {
    const url = `${location.origin}/#/room/${state.room.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("邀请链接已复制");
    } catch {
      toast(url);
    }
  };
  $("startBtn").onclick = async () => {
    try {
      await api(`/api/rooms/${state.room.id}/start`, { token: state.room.token });
    } catch (e) {
      toast(e.message);
    }
  };
  const syncSettings = async () => {
    const step = Number($("stepRange").value) * 1000;
    const bank = Number($("bankRange").value) * 1000;
    $("stepOut").textContent = `${(step / 1000).toFixed(1)}s`;
    $("bankOut").textContent = `${(bank / 1000).toFixed(0)}s`;
    try {
      await api(`/api/rooms/${state.room.id}/settings`, { token: state.room.token, stepMs: step, bankMs: bank });
    } catch {
      /* not host */
    }
  };
  $("stepRange").oninput = syncSettings;
  $("bankRange").oninput = syncSettings;
  $("roomName").onchange = async () => {
    try {
      await api(`/api/rooms/${state.room.id}/settings`, { token: state.room.token, name: $("roomName").value });
    } catch {
      /* not host */
    }
  };
}

function renderRoom() {
  const info = room.info;
  if (!info) return;
  $("roomSub").textContent = `${info.name} · ${info.state === "playing" ? "对战中" : info.state === "finished" ? "已结束" : "等待玩家"}`;
  const host = info.host;
  $("startBtn").disabled = !host || info.state !== "lobby";
  $("startBtn").textContent = host ? "开始对局" : "等待房主开始";
  if (info.state === "playing" || info.state === "finished") {
    if (!$("view-game").classList.contains("active")) show("game");
    return;
  }
  $("stepRange").value = info.settings.stepMs / 1000;
  $("bankRange").value = info.settings.bankMs / 1000;
  $("stepOut").textContent = `${(info.settings.stepMs / 1000).toFixed(1)}s`;
  $("bankOut").textContent = `${(info.settings.bankMs / 1000).toFixed(0)}s`;
  $("roomName").value = info.name;

  document.querySelectorAll("#gamesSeg button").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.games) === Number(info.settings.games || 1));
    b.disabled = !host || info.state !== "lobby";
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.id}/settings`, {
          token: state.room.token,
          games: Number(b.dataset.games),
        });
      } catch (e) {
        toast(e.message);
      }
    };
  });

  document.querySelectorAll("#paceSeg button").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.pace) === Number(info.settings.paceMs ?? 800));
    b.disabled = !host || info.state !== "lobby";
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.id}/settings`, {
          token: state.room.token,
          paceMs: Number(b.dataset.pace),
        });
      } catch (e) {
        toast(e.message);
      }
    };
  });

  const grid = $("seatGrid");
  grid.innerHTML = info.seats
    .map((s, i) => {
      const color = seatColor(i);
      const filled = s.kind !== "empty";
      const sub =
        s.kind === "ai"
          ? `AI · ${difficultyLabel(s.difficulty)}`
          : s.kind === "human"
          ? s.connected
            ? "在线"
            : "离线"
          : "等待玩家";
      const noAI = difficulties().length === 0;
      const pills =
        host && info.state === "lobby"
          ? `<div class="fill-actions">
               ${difficulties()
                 .map((d) => `<button class="pill" data-seat="${i}" data-kind="ai" data-diff="${d.key}">${d.label}</button>`)
                 .join("")}
               <button class="pill" data-seat="${i}" data-kind="empty">清空</button>
               ${noAI ? `<span class="hint" style="margin:0;font-size:10px">找不到 AI 程序</span>` : ""}
             </div>`
          : "";
      return `<div class="seat ${filled ? "filled" : ""}" style="--sc:${color}">
        <div class="seat-no">SEAT ${i + 1}${s.you ? " · 你" : ""}</div>
        <div class="who">
          <div class="avatar">${filled ? escapeHtml(s.avatar) : "?"}</div>
          <div>
            <div class="nm">${filled ? escapeHtml(s.name) : "空位"}</div>
            <div class="tag" title="${s.kind === "ai" ? escapeHtml(s.desc || "") : ""}">${sub}</div>
          </div>
        </div>
        ${pills}
      </div>`;
    })
    .join("");
  grid.querySelectorAll(".pill").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.id}/seat`, {
          token: state.room.token,
          seat: Number(b.dataset.seat),
          kind: b.dataset.kind,
          difficulty: b.dataset.diff,
        });
      } catch (e) {
        toast(e.message);
      }
    };
  });

  $("seatSummary").textContent = `${info.seats.filter((s) => s.kind !== "empty").length}/4`;
  $("seatSummaryList").innerHTML = info.seats
    .filter((s) => s.kind !== "empty")
    .map(
      (s) => `<div class="summary-row" style="--sc:${seatColor(s.seat)}">
        <span class="dot"></span><span>${escapeHtml(s.name)}</span>
        <span style="margin-left:auto;color:var(--dim);font-size:11px">${s.kind === "ai" ? difficultyLabel(s.difficulty) : "玩家"}</span>
      </div>`
    )
    .join("");
}

// ------------------------------------------------------------------- game
function currentGrid() {
  return state.grid || board.grid;
}

function myExplorer() {
  if (!state.snapshot) return null;
  return state.snapshot.players.find((p) => p.id === state.snapshot.seat);
}

function applySnapshot(snap, resolved) {
  if (!snap) return;
  state.snapshot = snap;
  state.clockOffset = snap.serverNow - Date.now();
  if (!state.grid || state.gameMap !== snap.map) {
    state.grid = snap.grid;
    state.gameMap = snap.map;
    board.setGame({
      grid: snap.grid,
      players: (snap.seats || []).map((s) => ({ name: s.name || `P${s.seat}` })),
      me: snap.seat,
    });
  }
  board.players = (snap.seats || []).map((s) => ({ name: s.name || `P${s.seat}` }));
  board.me = snap.seat;
  board.setState(snap.entities, resolved);
  if (!$("resultModal").hidden) {
    $("resultModal").hidden = true;
    if (countdownTimer) clearInterval(countdownTimer);
  }
  if (!$("view-game").classList.contains("active")) show("game");
  renderGame();
  updateFeed();
}

function renderGame() {
  const snap = state.snapshot;
  if (!snap) return;
  $("turnNum").textContent = `T${snap.turn}`;
  $("turnMap").textContent = snap.map || "";
  $("turnMap").title = snap.seed ? `种子 ${snap.seed}` : "";
  const pm = snap.params || [];
  $("turnParams").innerHTML = pm.length
    ? `<span class="param-chip danger" title="2 格内没有同伴时，每回合掉多少理智">落单 <b>-${pm[0]}</b></span>
       <span class="param-chip calm" title="2 格内有同伴时，每回合掉多少理智">结伴 <b>-${pm[1]}</b></span>
       <span class="param-chip" title="游荡者出现后需要几回合凝聚；被召唤后能存活几回合">游魂 <b>${pm[2]}</b> 回合现身<span class="u">/ 存活 ${pm[3]}</span></span>`
    : "";
  const ser = snap.series;
  $("boardHud").innerHTML = `
    <span class="hud-chip">回合 <b>${snap.turn}</b></span>
    <span class="hud-chip">${snap.finished ? "已结束" : snap.isMyTurn ? "轮到你" : "等待中"}</span>
    ${ser && ser.total > 1 ? `<span class="hud-chip">第 <b>${ser.index}</b> / ${ser.total} 局</span>` : ""}`;

  $("players").innerHTML = snap.players
    .map((p) => {
      const s = (snap.seats || [])[p.id];
      const color = seatColor(p.id);
      const pct = Math.max(0, Math.min(100, (p.sanity / 250) * 100));
      const isYou = p.id === snap.seat;
      const done = !p.alive ? true : !snap.pending.includes(p.id);
      const row = ser && ser.total > 1 && ser.results.length ? ser.rows.find((r) => r.seat === p.id) : null;
      return `<div class="pcard ${isYou ? "you" : ""} ${p.alive ? "" : "dead"} ${done ? "" : "acting"}" style="--sc:${color}">
        <div class="pav">${escapeHtml(s?.avatar || String(p.id))}</div>
        <div>
          <div class="pname">${escapeHtml(s?.name || `P${p.id}`)}${isYou ? '<span class="you-tag">你</span>' : ""}${
            row ? `<span class="pts-badge" title="系列赛累计">${row.points}</span>` : ""
          }</div>
          <div class="pbar"><i style="width:${pct}%;background:${sanColor(p.sanity)}"></i></div>
          <div class="pmeta"><span>${p.alive ? `理智 ${Math.max(0, p.sanity)}` : "已出局"}</span>
            <span>PLAN ${p.plans}</span><span>LIGHT ${p.lights}</span></div>
        </div>
        <div class="psan">${p.alive ? Math.max(0, p.sanity) : "—"}<small>${p.alive ? "" : `T${p.deathTurn ?? "?"}`}</small></div>
      </div>`;
    })
    .join("");

  $("turnPending").innerHTML = snap.players
    .filter((p) => p.alive)
    .map((p) => {
      const s = (snap.seats || [])[p.id];
      const done = !snap.pending.includes(p.id);
      return `<span class="pending-seat ${done ? "done" : ""}" style="--sc:${seatColor(p.id)}"><span class="dot"></span>${escapeHtml(s?.avatar || p.id)}</span>`;
    })
    .join("");

  const me = myExplorer();
  const canAct = snap.isMyTurn && me && me.alive;
  document.querySelectorAll(".act-btn").forEach((b) => (b.disabled = !canAct));
  if (me) {
    $("planCount").textContent = `剩 ${me.plans}`;
    $("lightCount").textContent = `剩 ${me.lights}`;
  }
  $("actionTitle").innerHTML = snap.finished
    ? "对局结束"
    : snap.seat < 0
    ? "观战中 — 四个座位都由 AI 操作"
    : !me || !me.alive
    ? "你已出局，观战中"
    : snap.submitted
    ? "已提交，仍可改 — 等其他人行动"
    : snap.isMyTurn
    ? "轮到你 — <b>点棋盘移动</b>，或按快捷键"
    : "等待其他玩家…";
  $("submitState").className = "submit-state" + (snap.submitted ? " ok" : "");
  $("submitState").textContent = snap.submitted
    ? `已提交 ${snap.lastAction || ""}（点棋盘 / 快捷键可修改）`
    : `备用时间 ${(Math.max(0, snap.bankMs) / 1000).toFixed(1)}s`;
}

$("actionPanel").addEventListener("click", (e) => {
  const btn = e.target.closest(".act-btn");
  if (!btn || btn.disabled) return;
  submit(btn.dataset.action);
});

async function submit(action) {
  if (!state.room || !state.snapshot || !state.snapshot.isMyTurn) return;
  try {
    await api(`/api/rooms/${state.room.id}/act`, {
      token: state.room.token,
      seat: state.snapshot.seat,
      turn: state.snapshot.turn,
      action,
    });
  } catch (e) {
    toast(e.message);
  }
}

function sanColor(s) {
  const t = Math.max(0, Math.min(1, s / 250));
  return `hsl(${4 + 128 * t} 72% 52%)`;
}

function updateFeed() {
  const snap = state.snapshot;
  if (!snap) return;
  const el = $("feed");
  const feed = snap.feed || [];
  if (!feed.length) {
    el.innerHTML = `<div class="empty">对局日志会出现在这里：谁被吓到、谁放了技能、谁超时。</div>`;
    return;
  }
  el.innerHTML = feed
    .slice(-40)
    .map((f) => `<div class="feed-line ${/fooled|Invalid|timeout|超时/i.test(f.text) ? "hot" : ""}">${escapeHtml(f.text)}</div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}

function tickClock() {
  const snap = state.snapshot;
  if (!snap || !snap.isMyTurn || snap.submitted) {
    $("clockText").textContent = "—";
    $("clockArc").style.strokeDashoffset = "119.4";
    $("turnClock").classList.remove("warn");
    return;
  }
  const now = Date.now() + state.clockOffset;
  const total = Math.max(1, snap.stepMs + Math.max(0, snap.bankMs));
  const left = Math.max(0, snap.deadline - now);
  const stepLeft = left - Math.max(0, snap.bankMs);
  const inBank = stepLeft <= 0;
  const shown = inBank ? left : stepLeft;
  $("clockText").textContent = (shown / 1000).toFixed(1);
  $("clockArc").style.strokeDashoffset = String(119.4 * (1 - left / total));
  $("turnClock").classList.toggle("warn", inBank);
}

window.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if (!state.snapshot || !state.snapshot.isMyTurn) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const me = myExplorer();
  if (!me) return;
  const dirs = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  };
  if (dirs[e.key]) {
    e.preventDefault();
    const [dx, dy] = dirs[e.key];
    const nx = me.x + dx;
    const ny = me.y + dy;
    const g = currentGrid();
    if (!g[ny] || !g[ny][nx] || g[ny][nx] === "#") {
      toast("那边是墙");
      return;
    }
    submit(`MOVE ${nx} ${ny}`);
    return;
  }
  const k = e.key.toLowerCase();
  if (k === " " || e.key === "Spacebar") {
    e.preventDefault();
    submit("WAIT");
  } else if (k === "p") submit("PLAN");
  else if (k === "l") submit("LIGHT");
  else if (k === "y") submit("YELL");
});

// ---------------------------------------------------------------- result
let countdownTimer = null;

function showResult({ result, series, replay }) {
  const snap = state.snapshot;
  const seats = snap?.seats || room.info?.seats || [];
  state.lastResult = { result, series, replay };
  const nameOf = (seat) => escapeHtml(seats[seat]?.name || `P${seat}`);
  const avatarOf = (seat, size = 22) =>
    `<span class="score-avatar" style="--sc:${seatColor(seat)};width:${size}px;height:${size}px">${escapeHtml(seats[seat]?.avatar || seat)}</span>`;

  const done = !series || series.done || series.index >= series.total;
  const isHost = !!room.info?.host;
  const myPlace = result?.order?.find((o) => o.seat === snap?.seat)?.place;

  $("resultTitle").textContent = done
    ? series && series.total > 1
      ? "系列赛结束"
      : myPlace === 1
      ? "你活到了最后"
      : "对局结束"
    : `第 ${series.index} / ${series.total} 局结束`;

  const gameTable = `
    <div class="score-block">
      <h4>本局名次</h4>
      <table class="score-table">
        <tr><th>#</th><th>玩家</th><th>状态</th><th class="pts">得分</th></tr>
        ${(result?.order || [])
          .map(
            (o) => `<tr class="${o.place === 1 ? "win" : ""}">
              <td class="pts ${o.place === 1 ? "p1" : ""}">${o.place}</td>
              <td>${avatarOf(o.seat)}${nameOf(o.seat)}${o.seat === snap?.seat ? " · 你" : ""}</td>
              <td>${o.alive ? `存活 · 理智 ${o.sanity}` : `T${o.deathTurn} 出局`}</td>
              <td class="pts">+${o.points}</td>
            </tr>`
          )
          .join("")}
      </table>
    </div>`;

  const totalTable =
    series && series.total > 1
      ? `<div class="score-block">
          <h4>累计积分 · ${series.index} / ${series.total} 局</h4>
          <table class="score-table">
            <tr><th>#</th><th>玩家</th><th>胜局</th><th class="pts">总分</th></tr>
            ${series.rows
              .map(
                (r, i) => `<tr class="${i === 0 ? "win" : ""}">
                  <td class="pts ${i === 0 ? "p1" : ""}">${i + 1}</td>
                  <td>${avatarOf(r.seat)}${escapeHtml(r.name)}${r.seat === snap?.seat ? " · 你" : ""}</td>
                  <td>${r.wins}</td>
                  <td class="pts ${i === 0 ? "p1" : ""}">${r.points}</td>
                </tr>`
              )
              .join("")}
          </table>
        </div>`
      : "";

  $("resultBody").innerHTML = gameTable + totalTable;

  $("watchReplay").hidden = !replay;
  $("watchReplay").onclick = () => {
    $("resultModal").hidden = true;
    if (replay) location.hash = `#/replay/${replay}`;
    else toast("录像稍后生成");
  };

  $("nextGameBtn").hidden = done || !isHost;
  $("nextGameBtn").onclick = async () => {
    try {
      await api(`/api/rooms/${state.room.id}/next`, { token: state.room.token });
    } catch (e) {
      toast(e.message);
    }
  };
  $("endSeriesBtn").hidden = done || !isHost;
  $("endSeriesBtn").onclick = async () => {
    try {
      await api(`/api/rooms/${state.room.id}/end-series`, { token: state.room.token });
    } catch (e) {
      toast(e.message);
    }
  };
  $("backHome").hidden = !done;
  $("backHome").onclick = () => {
    $("resultModal").hidden = true;
    location.hash = "#/";
  };

  startCountdown(done ? 0 : series.nextAt);
  $("resultModal").hidden = false;
}

function startCountdown(nextAt) {
  if (countdownTimer) clearInterval(countdownTimer);
  const el = $("nextHint");
  if (!nextAt) {
    el.textContent = "";
    return;
  }
  const tick = () => {
    const left = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    el.textContent = left > 0 ? `${left} 秒后自动开始下一局` : "正在开始下一局…";
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

// ---------------------------------------------------------------- replay
async function enterReplay(id) {
  try {
    const bundle = await api(`/api/replays/${id}`);
    state.replay = bundle;
    state.rp = { idx: 0, playing: false, speed: 1, last: 0, acc: 0 };
    show("replay");
    replayBoard.setGame({
      grid: bundle.grid,
      players: (bundle.meta?.seats || []).map((s) => ({ name: s.name })),
      me: -1,
    });
    const scr = $("rpScrub");
    scr.max = String(bundle.turns.length - 1);
    scr.value = "0";
    scr.oninput = () => {
      state.rp.idx = Number(scr.value);
      state.rp.playing = false;
      $("rpPlay").textContent = "▶";
      renderReplay();
    };
    $("rpPlay").onclick = () => {
      state.rp.playing = !state.rp.playing;
      $("rpPlay").textContent = state.rp.playing ? "❚❚" : "▶";
    };
    $("rpSpeed").onchange = () => (state.rp.speed = Number($("rpSpeed").value));
    renderReplay();
  } catch (e) {
    toast(e.message);
    location.hash = "#/";
  }
}

function renderReplay() {
  const b = state.replay;
  if (!b) return;
  const i = Math.max(0, Math.min(b.turns.length - 1, state.rp.idx));
  const turn = b.turns[i];
  const smooth = Math.abs(i - (state.rp.shown ?? i)) === 1;
  state.rp.shown = i;
  replayBoard.setState(turn.ent, smooth);
  $("rpTurn").textContent = `T${turn.t}`;
  $("rpScrub").value = String(i);
  $("replayHud").innerHTML = `<span class="hud-chip">地图 <b>${escapeHtml(b.map)}</b></span>
    <span class="hud-chip">第 <b>${turn.t}</b> 回合</span>
    ${
      b.params
        ? `<span class="param-chip danger" title="落单时每回合掉多少理智">落单 <b>-${b.params[0]}</b></span>
           <span class="param-chip calm" title="结伴时每回合掉多少理智">结伴 <b>-${b.params[1]}</b></span>
           <span class="param-chip" title="游荡者凝聚 / 存活回合数">游魂 <b>${b.params[2]}</b> / <b>${b.params[3]}</b></span>`
        : ""
    }`;
  const seats = b.meta?.seats || [];
  const dec = decodeEntities(turn.ent);
  $("replayPlayers").innerHTML = seats
    .map((s) => {
      const p = dec.explorers.find((e) => e.id === s.seat);
      const color = seatColor(s.seat);
      const pct = p ? Math.max(0, Math.min(100, (p.sanity / 250) * 100)) : 0;
      return `<div class="pcard ${p ? "" : "dead"}" style="--sc:${color}">
        <div class="pav">${escapeHtml(s.name?.[0] || s.seat)}</div>
        <div>
          <div class="pname">${escapeHtml(s.name || `P${s.seat}`)}</div>
          <div class="pbar"><i style="width:${pct}%;background:${sanColor(p ? p.sanity : 0)}"></i></div>
          <div class="pmeta"><span>${p ? `理智 ${p.sanity}` : "已出局"}</span>${p ? `<span>PLAN ${p.plans}</span><span>LIGHT ${p.lights}</span>` : ""}</div>
        </div>
        <div class="psan">${p ? p.sanity : "—"}</div>
      </div>`;
    })
    .join("");
  $("replayFeed").innerHTML = b.turns
    .slice(Math.max(0, i - 6), i + 1)
    .map((t) => `<div class="feed-line"><span class="t">T${t.t}</span>${escapeHtml(t.plays.map((p) => (p.a && p.a.raw) || "").join(" · "))}</div>`)
    .join("");
  $("replayFeed").scrollTop = $("replayFeed").scrollHeight;
}

function replayTick(now) {
  const rp = state.rp;
  if (state.replay && rp.playing) {
    const dt = now - (rp.last || now);
    rp.last = now;
    rp.acc += (dt / 1000) * rp.speed * 2.2;
    if (rp.acc >= 1) {
      rp.idx = Math.min(state.replay.turns.length - 1, rp.idx + Math.floor(rp.acc));
      rp.acc = 0;
      if (rp.idx >= state.replay.turns.length - 1) {
        rp.playing = false;
        $("rpPlay").textContent = "▶";
      }
      renderReplay();
    }
  } else {
    rp.last = now;
  }
}

// ------------------------------------------------------------------ router
async function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  if (state.es && !/^\/room\//.test(h)) {
    state.es.close();
    state.es = null;
  }
  const mRoom = /^\/room\/([A-Z0-9]+)/.exec(h);
  const mReplay = /^\/replay\/(.+)$/.exec(h);
  if (mRoom) await enterRoom(mRoom[1]);
  else if (mReplay) await enterReplay(mReplay[1]);
  else {
    state.room = null;
    state.snapshot = null;
    show("home");
    loadHome();
  }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------- boot
function loop(now) {
  tickClock();
  replayTick(now);
  requestAnimationFrame(loop);
}

(async function boot() {
  applyTheme(state.theme);
  api("/api/bots")
    .then((r) => {
      state.bots = r.bots;
      if (room.info) renderRoom();
    })
    .catch(() => {});
  // a shared invite can carry the nickname: /?name=阿橘#/room/ABCDE
  const qs = new URLSearchParams(location.search);
  if (qs.get("name")) setMe(qs.get("name"));
  if (state.me) {
    setMe(state.me.name);
    route();
  } else {
    $("nameDialog").showModal();
    $("nameDialog").addEventListener(
      "close",
      () => {
        if (!state.me) setMe($("nickInput").value || "探索者");
        route();
      },
      { once: true }
    );
  }
  requestAnimationFrame(loop);
})();

window.__arena = { state, board, room };
