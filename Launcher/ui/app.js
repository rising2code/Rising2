"use strict";

// ---------- Bridge to Go ----------
// In the launcher, Go injects window.__rpc. Opened as a plain file in a browser
// (for UI work), a small mock answers instead.
const call = (() => {
  if (!window.__rpc) return mockCall;
  let seq = 0;
  const pending = {};
  window.__rpcDone = (id, r) => {
    const p = pending[id];
    delete pending[id];
    if (p) r.ok ? p.resolve(r.value) : p.reject(new Error(r.value));
  };
  return (method, args = null) => {
    if (method.startsWith("win.")) { window.__rpc(0, method, null); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending[id] = { resolve, reject };
      window.__rpc(id, method, args);
    });
  };
})();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
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
$("#titlebar").addEventListener("mousedown", (e) => {
  if (e.button === 0 && !e.target.closest("button")) call("win.drag");
});
$("#btnMin").onclick = () => call("win.minimize");
$("#btnClose").onclick = () => call("win.close");
document.addEventListener("contextmenu", (e) => e.preventDefault());

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
  const req = {
    exe: dupExe.value.trim().replace(/^"|"$/g, ""),
    count: parseInt($("#dupCount").value, 10) || 0,
    log: $("#dupLog").checked,
    storage: $("#dupStorage").checked,
  };
  if (!req.exe) { log("Choose RisingEagle.exe first.", "warn"); return; }
  run(e.currentTarget, `Creating ${req.count} copies`, () => call("dup.create", req));
};

// ---------- 3] Info ----------
let infoTexts = {};
function showInfo(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.info === name));
  const pre = $("#infoText");
  pre.textContent = infoTexts[name] || "";
  pre.scrollTop = 0;
  pre.classList.remove("fade-in");
  void pre.offsetWidth;
  pre.classList.add("fade-in");
}
$$(".tab").forEach((t) => (t.onclick = () => showInfo(t.dataset.info)));

// ---------- 4] Links ----------
let linksLoaded = false;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
    pill.textContent = r.online ? "latest from GitHub" : "offline copy";
    pill.title = r.error || "";
    return r.online ? "Links updated." : "Offline, showing built-in links (" + r.error + ")";
  });
}
$("#btnLinks").onclick = loadLinks;
$("#linksBox").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-url]");
  if (a) call("open.url", a.dataset.url).catch((err) => log("ERROR: " + err.message, "err"));
});

// ---------- Boot ----------
(async function boot() {
  log("RISING2 LAUNCHER // booting");
  try {
    const b = await call("app.boot");
    $("#ver").textContent = "v" + b.version;
    $("#hostsPath").textContent = b.hostsPath;
    $("#who").innerHTML = (b.elevated ? "🛡 Running as admin" : "👤 Normal user<br>(asks for admin only when needed)") +
      "<br>WebView2 " + esc(b.webview || "?");
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
      version: "dev", elevated: false, webview: "mock", hostsPath: "C:\\Windows\\System32\\drivers\\etc\\hosts",
      domains: ["gpcm.reagspy.com", "gpsp.reagspy.com", "master.reagspy.com"],
      info: { "exe-args.txt": "-fullscreen   (preview text)", "admin-commands.txt": "sudo help", "tcl-basics.txt": "sel /sys/", "tcl-example.tcl": "proc x {} {}" },
    }, 50);
    case "hosts.status": return wait([]);
    case "hosts.apply": return args.ip ? wait(`Redirected ${args.domains.length} domains to ${args.ip}.`, 1200) : wait("Removed all Rising Eagle redirects.");
    case "dup.pick": return wait("C:\\Games\\Rising Eagle\\RisingEagle.exe");
    case "dup.create": return Promise.reject(new Error("mock: open RisingEagle.exe failed"));
    case "links.fetch": return wait({ text: "# Discords\n\nhttps://discord.com/invite/example [Newer]\n\n## Old\nhttps://example.com", online: false, error: "mock" });
    default: return wait(null, 10);
  }
}
