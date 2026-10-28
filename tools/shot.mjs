/**
 * Minimal CDP driver (no dependencies, uses Node's built-in WebSocket).
 *
 *   node tools/shot.mjs --url http://127.0.0.1:8787 --out build/home.png \
 *        --script "click:#createBtn; wait:400; shot:build/dialog.png"
 *
 * The script steps are the QA flow: every "click:" really dispatches a DOM
 * click in the page, so this exercises the same code path a player uses.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

const url = flag("--url", "http://127.0.0.1:8787");
const out = flag("--out", "build/shot.png");
const steps = flag("--script", "");
const width = Number(flag("--width", "1600"));
const height = Number(flag("--height", "1000"));

const profile = path.resolve("build/chrome-profile");
fs.mkdirSync(profile, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("chrome did not start")), 15000);
  chrome.stderr.on("data", (d) => {
    buf += String(d);
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error("ws error"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const cdp = new CDP(wsUrl);
await cdp.ready;

const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);
await cdp.send("Page.navigate", { url }, sessionId);
await new Promise((r) => setTimeout(r, 1800));

async function evaluate(expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + " " + (res.exceptionDetails.exception?.description || ""));
  return res.result?.value;
}

async function shoot(file) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log("shot ->", file);
}

for (const raw of steps.split(";;").map((s) => s.trim()).filter(Boolean)) {
  const [cmd, ...rest] = raw.split(":");
  const arg = rest.join(":");
  if (cmd === "wait") await new Promise((r) => setTimeout(r, Number(arg)));
  else if (cmd === "shot") await shoot(arg);
  else if (cmd === "click") {
    const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) console.log("!! click failed:", arg);
    await new Promise((r) => setTimeout(r, 250));
  }
  else if (cmd === "type") {
    const [sel, text] = arg.split("|");
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  }
  else if (cmd === "js") {
    const v = await evaluate(arg);
    if (v !== undefined) console.log("js:", JSON.stringify(v));
  }
  else if (cmd === "nav") {
    await cdp.send("Page.navigate", { url: arg }, sessionId);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

await shoot(out);

try {
  chrome.kill();
} catch {
  /* ignore */
}
process.exit(0);
