"use strict";

// ---------- Bridge to Go ----------
// In the launcher, Go injects window.__rpc. Opened as a plain file in a browser
// (for UI work), a small mock answers instead.
const rpc = (() => {
  if (!window.__rpc) return mockCall;
  let seq = 0;
  const pending = {};
  window.__rpcDone = (id, r) => {
    const p = pending[id];
    delete pending[id];
    if (p) r.ok ? p.resolve(r.value) : p.reject(new Error(r.value));
  };
  return (method, args = null) => {
    if (method.startsWith("win.")) { window.__rpc(0, method, args); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending[id] = { resolve, reject };
      window.__rpc(id, method, args);
    });
  };
})();

// Every backend call makes the tray network icon blink, like XP network activity.
let inFlight = 0;
function call(method, args = null) {
  if (method.startsWith("win.")) return rpc(method, args);
  inFlight++;
  $("#trayNet").classList.add("busy");
  return rpc(method, args).finally(() => {
    if (--inFlight === 0) $("#trayNet").classList.remove("busy");
  });
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- Hacker console ----------
const consoleEl = $("#console");
let typing = Promise.resolve();
function log(text, kind = "") {
  typing = typing.then(() => new Promise((done) => {
    $$(".console .cursor").forEach((c) => c.classList.remove("cursor"));
    const line = document.createElement("div");
    line.className = kind + " cursor";
    consoleEl.append(line);
    while (consoleEl.children.length > 5) consoleEl.firstChild.remove();
    const full = "> " + text;
    let i = 0;
    const step = () => {
      i = Math.min(full.length, i + 3);
      line.textContent = full.slice(0, i);
      i < full.length ? setTimeout(step, 12) : done();
    };
    step();
  }));
}

// Run an action with a busy button and console output.
async function run(btn, label, fn) {
  btn.disabled = true;
  btn.classList.add("busy");
  log(label + " …");
  try {
    const msg = await fn();
    if (msg) log(msg);
    return true;
  } catch (e) {
    log("ERROR: " + e.message, "err");
    return false;
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

// ---------- Window chrome ----------
// The page fills the whole window, so it finds the edge under the mouse itself and
// asks Windows to start a native resize (or a move, from the title bar).
const EDGE = 6;
const root = document.documentElement;
function edgeAt(e) {
  const v = e.clientY < EDGE ? "t" : e.clientY >= innerHeight - EDGE ? "b" : "";
  const h = e.clientX < EDGE ? "l" : e.clientX >= innerWidth - EDGE ? "r" : "";
  return v + h;
}
document.addEventListener("mousemove", (e) => {
  const edge = e.buttons ? "" : edgeAt(e);
  if (root.dataset.edge !== edge) root.dataset.edge = edge;
});
document.addEventListener("mouseleave", () => (root.dataset.edge = ""));
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const edge = edgeAt(e);
  if (edge) { e.preventDefault(); call("win.drag", edge); return; }
  if (e.target.closest("#titlebar") && !e.target.closest("button")) call("win.drag", "move");
});
$("#btnMin").onclick = () => call("win.minimize");
$("#btnClose").onclick = () => call("win.close");
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Text size: CSS zoom re-flows the layout (unlike transform: scale). Title bar stays put.
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
let zoomIdx = ZOOMS.indexOf(parseFloat(store.get("zoom", "1")));
if (zoomIdx < 0) zoomIdx = ZOOMS.indexOf(1);
function setZoom(i, announce = true) {
  zoomIdx = Math.min(ZOOMS.length - 1, Math.max(0, i));
  root.style.setProperty("--zoom", ZOOMS[zoomIdx]);
  store.set("zoom", ZOOMS[zoomIdx]);
  $("#btnZoomOut").disabled = zoomIdx === 0;
  $("#btnZoomIn").disabled = zoomIdx === ZOOMS.length - 1;
  if (announce) log(`Text size ${Math.round(ZOOMS[zoomIdx] * 100)}%`);
}
$("#btnZoomOut").onclick = () => setZoom(zoomIdx - 1);
$("#btnZoomIn").onclick = () => setZoom(zoomIdx + 1);
document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  const step = { "=": 1, "+": 1, "-": -1, "0": 0 }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  setZoom(step === 0 ? ZOOMS.indexOf(1) : zoomIdx + step);
});
setZoom(zoomIdx, false);

// Any element with data-url opens in the default browser.
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-url]");
  if (!a) return;
  e.preventDefault();
  call("open.url", a.dataset.url).catch((err) => log("ERROR: " + err.message, "err"));
});

// Ripple on every button.
document.addEventListener("pointerdown", (e) => {
  const b = e.target.closest(".btn, .nav, .tab");
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  b.append(s);
  s.addEventListener("animationend", () => s.remove());
});

// ---------- Matrix rain in the title bar ----------
(function matrix() {
  const cv = $("#matrix");
  const ctx = cv.getContext("2d");
  const glyphs = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789RISNGEAL2";
  const fs = 10;
  let drops = [];
  function resize() {
    cv.width = cv.clientWidth;
    cv.height = cv.clientHeight;
    drops = Array.from({ length: Math.ceil(cv.width / fs) }, () => Math.random() * -20);
  }
  resize();
  addEventListener("resize", resize);
  setInterval(() => {
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.font = fs + "px Consolas, monospace";
    drops.forEach((y, i) => {
      if (y > 0) {
        ctx.fillStyle = Math.random() < 0.08 ? "#dfffe6" : "#3cff6b";
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * fs, y * fs);
      }
      drops[i] = y * fs > cv.height && Math.random() > 0.9 ? Math.random() * -8 : y + 1;
    });
  }, 70);
})();

// ---------- Taskbar ----------
// Each task button owns one "app" panel. Like XP: clicking the active one minimizes it,
// clicking it again restores it.
$$(".task").forEach((btn) => (btn.onclick = () => {
  const app = document.getElementById(btn.dataset.app);
  const minimized = app.classList.toggle("minimized");
  btn.classList.toggle("active", !minimized);
}));

// Tray: network status and a clock stuck in November 2007 (time is real).
function syncOnline() {
  const net = $("#trayNet");
  net.classList.toggle("offline", !navigator.onLine);
  net.title = navigator.onLine ? "Local Area Connection\nConnected" : "Local Area Connection\nA network cable is unplugged";
}
addEventListener("online", syncOnline);
addEventListener("offline", syncOnline);
syncOnline();

function tick() {
  const now = new Date();
  const then = new Date(2007, 10, Math.min(now.getDate(), 30), now.getHours(), now.getMinutes());
  $("#clockTime").textContent = then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  $("#clockDate").textContent = then.toLocaleDateString("en-US");
  $("#clock").title = then.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
tick();
setInterval(tick, 5000);

// ---------- Navigation ----------
function show(page) {
  $$(".nav").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
  store.set("page", page);
  if (page === "links" && !linksLoaded) loadLinks();
}
$$(".nav").forEach((n) => (n.onclick = () => show(n.dataset.page)));

// ---------- 1] Hosts ----------
let defaultDomains = [];
const ipInput = $("#customIP");
const ipMode = () => $("input[name=ipmode]:checked").value;
function syncIP() { ipInput.classList.toggle("on", ipMode() === "custom"); }
$$("input[name=ipmode]").forEach((r) => (r.onchange = syncIP));
ipInput.addEventListener("input", () => {
  $("input[value=custom]").checked = true;
  syncIP();
  store.set("ip", ipInput.value.trim());
});
$("#domains").addEventListener("input", (e) => store.set("domains", e.target.value));
$("#resetDomains").onclick = (e) => {
  e.preventDefault();
  $("#domains").value = defaultDomains.join("\n");
  store.set("domains", "");
  log("Domain list reset to default (" + defaultDomains.length + ").");
};

async function hostsStatus() {
  const pill = $("#hostsState");
  try {
    const lines = await call("hosts.status");
    pill.className = "pill " + (lines.length ? "ok" : "warn");
    pill.textContent = lines.length ? `active: ${lines.length} domains → ${lines[0].split(/\s+/)[0]}` : "not redirected";
    pill.title = lines.join("\n");
  } catch (e) {
    pill.className = "pill warn";
    pill.textContent = "can't read hosts";
    pill.title = e.message;
  }
}

$("#btnHostsApply").onclick = (e) => {
  const ip = ipMode() === "local" ? "127.0.0.1" : ipInput.value.trim();
  if (!ip) { log("Type the fan server IP first.", "warn"); ipInput.focus(); return; }
  const domains = $("#domains").value.split(/\s+/).filter(Boolean);
  run(e.currentTarget, `Redirecting ${domains.length} domains to ${ip}`,
    () => call("hosts.apply", { ip, domains })).then(hostsStatus);
};
$("#btnHostsRemove").onclick = (e) => {
  const domains = $("#domains").value.split(/\s+/).filter(Boolean);
  run(e.currentTarget, "Removing redirect", () => call("hosts.apply", { ip: "", domains })).then(hostsStatus);
};

// ---------- 2] Duplicate client ----------
const dupExe = $("#dupExe");
dupExe.addEventListener("input", () => store.set("exe", dupExe.value.trim()));
$("#btnPick").onclick = async () => {
  const p = await call("dup.pick", dupExe.value.trim());
  if (p) { dupExe.value = p; store.set("exe", p); }
};
$("#btnDup").onclick = (e) => {
  const req = { exe: dupExe.value.trim(), count: parseInt($("#dupCount").value, 10) || 0 };
  if (!req.exe) { log("Choose RisingEagle.exe first.", "warn"); return; }
  run(e.currentTarget, `Creating ${req.count} copies`, () => call("dup.create", req));
};

// ---------- 3] Info ----------
// Minimal RTF -> HTML for the notes written in WordPad: colors, highlight, bold,
// italic, underline and fonts. Paragraph layout and font sizes are ignored.
const BS = "\\";
function rtfToHtml(rtf) {
  const colors = [null];
  const ct = /\{\\colortbl\s*;?([^}]*)\}/.exec(rtf);
  if (ct) ct[1].split(";").slice(0, -1).forEach((c) => {
    const n = (k) => +((new RegExp("\\\\" + k + "(\\d+)").exec(c) || [0, 0])[1]);
    colors.push(`rgb(${n("red")},${n("green")},${n("blue")})`);
  });
  const fonts = {};
  for (const m of rtf.matchAll(/\{\\f(\d+)(?:\\[a-z]+-?\d*)*\s+([^;}]*);\}/g)) fonts[m[1]] = m[2].trim();
  const cp1252 = new TextDecoder("windows-1252");
  const SKIP = new Set(["fonttbl", "colortbl", "stylesheet", "info", "generator", "pict", "header", "footer"]);

  let st = { b: 0, i: 0, u: 0, fg: 0, bg: 0, f: "0", skip: false };
  const stack = [];
  let html = "", run = "";
  const flush = () => {
    if (!run) return;
    const css = [];
    if (st.b) css.push("font-weight:bold");
    if (st.i) css.push("font-style:italic");
    if (st.u) css.push("text-decoration:underline");
    if (colors[st.fg]) css.push("color:" + colors[st.fg]);
    if (colors[st.bg]) css.push("background:" + colors[st.bg]);
    const font = fonts[st.f];
    if (font) css.push(`font-family:'${font}',${/courier|consol|mono/i.test(font) ? "monospace" : "Tahoma,sans-serif"}`);
    html += css.length ? `<span style="${css.join(";")}">${esc(run)}</span>` : esc(run);
    run = "";
  };
  const text = (t) => { if (!st.skip) run += t; };
  const set = (k, v) => { if (st[k] !== v) { flush(); st[k] = v; } };

  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === "{") { stack.push({ ...st }); i++; continue; }
    if (c === "}") { flush(); st = stack.pop() || st; i++; continue; }
    if (c === "\r" || c === "\n") { i++; continue; }
    if (c !== BS) { text(c); i++; continue; }
    const nx = rtf[i + 1];
    if (nx === BS || nx === "{" || nx === "}") { text(nx); i += 2; continue; }
    if (nx === "~") { text("\u00a0"); i += 2; continue; }
    if (nx === "*") { st.skip = true; i += 2; continue; }
    if (nx === "'") {
      const code = parseInt(rtf.substr(i + 2, 2), 16);
      text(fonts[st.f] === "Symbol" && code === 0xb7 ? "•" : cp1252.decode(Uint8Array.of(code)));
      i += 4; continue;
    }
    const m = /^\\([a-z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
    if (!m) { i += 2; continue; }
    i += m[0].length;
    const w = m[1], n = m[2] === undefined ? 1 : +m[2];
    if (SKIP.has(w)) st.skip = true;
    else if (w === "par" || w === "line") text("\n");
    else if (w === "tab") text("\t");
    else if (w === "b") set("b", n);
    else if (w === "i") set("i", n);
    else if (w === "ul") set("u", n);
    else if (w === "ulnone") set("u", 0);
    else if (w === "cf") set("fg", n);
    else if (w === "highlight" || w === "cb") set("bg", n);
    else if (w === "f") set("f", String(n));
    else if (w === "plain") { set("b", 0); set("i", 0); set("u", 0); set("fg", 0); set("bg", 0); }
    else if (w === "u") { text(String.fromCharCode(n < 0 ? n + 65536 : n)); if (rtf[i] !== BS) i++; }
  }
  flush();
  return html.replace(/\s+$/, "");
}

let infoTexts = {};
function showInfo(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.info === name));
  const panel = $("#infoText");
  const src = infoTexts[name] || "";
  const isRtf = src.trimStart().startsWith("{" + BS + "rtf");
  panel.classList.toggle("plain", !isRtf);
  panel.innerHTML = isRtf ? rtfToHtml(src) : esc(src);
  panel.scrollTop = 0;
  panel.classList.remove("fade-in");
  void panel.offsetWidth;
  panel.classList.add("fade-in");
}
$$(".tab").forEach((t) => (t.onclick = () => showInfo(t.dataset.info)));

// ---------- 4] Links ----------
let linksLoaded = false;
function renderLinks(text) {
  return text.split("\n").map((l) => {
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) return h[1].length === 1 ? `<h2>${esc(h[2])}</h2>` : `<h3>${esc(h[2])}</h3>`;
    return esc(l).replace(/https?:\/\/[^\s)]+/g, (u) => `<a data-url="${u}">${u}</a>`);
  }).join("\n").replace(/\n(<h[23]>)/g, "$1").replace(/(<\/h[23]>)\n/g, "$1");
}
async function loadLinks() {
  linksLoaded = true;
  const box = $("#linksBox");
  const pill = $("#linksState");
  await run($("#btnLinks"), "Fetching community links", async () => {
    const r = await call("links.fetch");
    box.innerHTML = renderLinks(r.text);
    box.classList.remove("fade-in"); void box.offsetWidth; box.classList.add("fade-in");
    pill.className = "pill " + (r.online ? "ok" : "warn");
    pill.textContent = r.online ? "latest from GitHub releases" : "offline copy · open GitHub releases";
    pill.title = (r.error ? r.error + "\n" : "") + "Open " + pill.dataset.url;
    return r.online ? "Links updated." : "Offline, showing built-in links (" + r.error + ")";
  });
}
$("#btnLinks").onclick = loadLinks;

// ---------- Boot ----------
(async function boot() {
  log("RISING2 LAUNCHER // booting");
  try {
    const b = await call("app.boot");
    $("#ver").textContent = b.version;
    $("#hostsPath").textContent = b.hostsPath;
    $("#who").innerHTML = (b.elevated ? "🛡 Running as admin" : "👤 Normal user<br>(asks for admin only when needed)") +
      "<br>WebView2 " + esc(b.webview || "?") + "<br>Launcher " + esc(b.version);
    defaultDomains = b.domains;
    infoTexts = b.info;
    $("#domains").value = store.get("domains", "") || defaultDomains.join("\n");
    ipInput.value = store.get("ip", "");
    if (ipInput.value) { $("input[value=custom]").checked = true; syncIP(); }
    dupExe.value = store.get("exe", "");
    showInfo("exe-args.txt");
    show(store.get("page", "hosts"));
    log(`WebView2 ${b.webview} OK · hosts: ${b.hostsPath}`);
    hostsStatus();
  } catch (e) {
    log("BOOT FAILED: " + e.message, "err");
  }
})();

// ---------- Mock backend (browser preview only) ----------
function mockCall(method, args) {
  const wait = (v, ms = 500) => new Promise((r) => setTimeout(() => r(v), ms));
  switch (method) {
    case "app.boot": return wait({
      version: "abc1234+dirty", elevated: false, webview: "mock", hostsPath: "C:\\Windows\\System32\\drivers\\etc\\hosts",
      domains: ["gpcm.reagspy.com", "gpsp.reagspy.com", "master.reagspy.com"],
      info: {
        "exe-args.txt": "-fullscreen   (preview text)",
        "admin-commands.rtf": String.raw`{\rtf1{\fonttbl{\f0\fnil Segoe UI;}}{\colortbl ;\red255\green255\blue0;}\f0 sudo \b help\b0\par    this help\par \highlight1\b # note\highlight0\b0 : x\par}`,
        "tcl-basics.rtf": "sel /sys/",
        "tcl-example.rtf": String.raw`{\rtf1{\fonttbl{\f0\fnil Courier New;}}{\colortbl ;\red0\green128\blue0;\red0\green0\blue255;}\f0\cf1 # comment\par\cf2\b proc\cf0\b0  x \{\{desc ""\}\} \{\par\}}`,
      },
    }, 50);
    case "hosts.status": return wait([]);
    case "hosts.apply": return args.ip ? wait(`Redirected ${args.domains.length} domains to ${args.ip}.`, 1200) : wait("Removed all Rising Eagle redirects.");
    case "dup.pick": return wait("C:\\Games\\Rising Eagle\\RisingEagle.exe");
    case "dup.create": return Promise.reject(new Error("mock: open RisingEagle.exe failed"));
    case "links.fetch": return wait({ text: "# Discords\n\nhttps://discord.com/invite/example [Newer]\n\n## Old\nhttps://example.com", online: false, error: "mock" });
    default: return wait(null, 10);
  }
}
