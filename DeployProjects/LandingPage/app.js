"use strict";
// ---- settings: fill these in before deploying ----
const CONFIG = {
  api: "/api",                                  // CF-Worker route on the same domain
  discord: "https://discord.gg/REPLACE_ME",
  download: "#download-coming-soon",            // direct download of the game + Rising2 launcher
  turnstileSiteKey: "1x00000000000000000000AA", // Cloudflare's always-pass test key; replace
};

const T = {
  he: {
    "nav.why": "למה Rising2", "nav.gallery": "גלריה", "nav.join": "איך מצטרפים", "nav.faq": "שאלות",
    "hero.kicker": "קהילת מעריצים · השרתים חזרו",
    "hero.title": "המלחמה של 2040, ממשחק של 2007, חזרה לאוויר",
    "hero.lead": "Rising Eagle חוזר לחיים. מורידים, מתקינים, ותוך כמה דקות אתם בקרב אונליין - עם התחברות, רשימת שרתים ודרגות שנשמרות, בדיוק כמו פעם.",
    "cta.download": "הורדת ZIP ‏(1.3GB)", "cta.discord": "הצטרפו לדיסקורד",
    "status.title": "מצב השרת",
    "state.off": "ישן", "state.starting": "עולה", "state.up": "פעיל", "state.stopping": "נכבה", "state.error": "תקלה", "state.unknown": "לא ידוע",
    "text.off": "השרת ישן כשאין שחקנים. העירו אותו בלחיצה - ותזמינו את החברים.",
    "text.starting": "השרת עולה. זה לוקח כמה דקות - הדף מתעדכן לבד.",
    "text.up": "השרת פעיל! פתחו את המשחק ובחרו אותו ברשימת השרתים.",
    "text.stopping": "השרת שומר נתונים ונכבה.",
    "text.error": "משהו השתבש בהפעלה. נסו שוב או כתבו בדיסקורד.",
    "text.unknown": "לא הצלחנו לקרוא את מצב השרת.",
    "start.hint": "אישור קצר שאתם לא בוט, ואז השרת מתחיל לעלות.",
    "start.btn": "העירו את השרת", "start.sending": "שולח…", "start.ok": "הבקשה התקבלה, השרת עולה!",
    "start.captcha": "אימות נכשל - נסו שוב.", "start.cooldown": "כבר הפעלתם היום. נסו שוב בעוד ~{h} שעות.",
    "start.running": "השרת כבר פעיל או עולה.", "start.budget": "התקציב החודשי של השרת נגמר. נחזור בחודש הבא - פרטים בדיסקורד.", "start.fail": "הבקשה נכשלה. נסו שוב מאוחר יותר.",
    "why.title": "משחקים בחינם, עם מעריצים אחרים",
    "why.free": "חינם וקוד פתוח", "why.free.d": "בלי מנוי ובלי פרסומות, וכל הקוד פתוח ב-GitHub.",
    "why.play": "משחקים עכשיו", "why.play.d": "המשגר מגדיר הכול לבד. השרת ישן? לחיצה אחת כאן והוא עולה בתוך דקות.",
    "why.ranks": "דרגות ומדליות", "why.ranks.d": "בדיוק כמו ב-2007, כל הפיצ'רים חזרו. הדרגה שלכם נשמרת.",
    "why.new": "חדש", "why.new.d": "בזכות כלי מודים חדשים יש לנו מפות ועונות חדשות. הישארו מעודכנים!",
    "gal.title": "גלריה",
    "gal.intro": "היכרות",
    "gal.arc": "שער הניצחון",
    "gal.china": "חזית סין", "gal.courtyard": "חצר תחת אש", "gal.hacking": "האקר קרב בפעולה",
    "gal.trooper": "לוחם עם שלד חיצוני", "gal.docks": "קרב בנמל", "gal.tactical": "מפה טקטית ופקודות",
    "gal.menu": "רשימת השרתים - שוב מלאה",
    "gal.video": "סרטון יתווסף בקרוב",
    "join.title": "מצטרפים בשני צעדים",
    "join.sub": "בלי להתעסק עם הגדרות. המשגר של Rising2 עושה את העבודה.",
    "join.s1": "מורידים", "join.s1.d": "הורידו את המשחק עם משגר Rising2 והתקינו. המשגר מחבר את המשחק לשרתי המעריצים.",
    "join.s2": "משחקים", "join.s2.d": "פותחים חשבון במסך הכניסה, בוחרים שרת ברשימה ונכנסים לקרב. השרת ישן? העירו אותו כאן או עם ‎/start בדיסקורד.",
    "about.title": "על המשחק",
    "about.p1": "Rising Eagle הוא משחק יריות מגוף ראשון מרובה משתתפים משנת 2007, המתרחש בסביבות 2040: ארצות הברית נלחמת לשמור על מעמדה מול סין ופדרציית האומות האירופית. אתם \"סופר-מרינס\" - לוחמים עם שלד חיצוני, מודיעין ושליטה ובקרה מתקדמים.",
    "about.p2": "משחק קבוצתי וטקטי, אבל גם מהיר ואגרסיבי - והאיזון בין השניים נקבע על ידי השחקנים. הדרגות והמדליות נשמרות שוב, כך שכל קרב נחשב.",
    "faq.title": "שאלות נפוצות",
    "faq.q1": "זה בחינם?", "faq.a1": "כן.",
    "faq.q2": "למה השרת לפעמים ישן?",
    "faq.a2": "הפרויקט ממומן על ידי מעריצים. כדי לחסוך בעלויות, שרת המשחק נכבה לבד אם אף אחד לא שיחק ב-15 הדקות האחרונות, או ב-05:00 בבוקר בכל יום. ככה כולנו יכולים להרשות לעצמנו לשחק שוב. כל הנקודות והדרגות נשמרות עד ההפעלה הבאה.",
    "faq.q3": "איך יוצרים איתכם קשר?", "faq.a3": "בדיסקורד:",
    "footer.fan": "פרויקט מעריצים לא רשמי ללא מטרות רווח. Rising Eagle הוא סימן מסחרי של Invasion Interactive. אין קשר בין Rising2 לבעלי הזכויות.",
  },
  en: {
    "nav.why": "Why Rising2", "nav.gallery": "Gallery", "nav.join": "How to join", "nav.faq": "FAQ",
    "hero.kicker": "Fan community · the servers are back",
    "hero.title": "The 2040 war from a 2007 game is back online",
    "hero.lead": "Rising Eagle lives again. Download, install, and minutes later you're fighting online - with login, the server list and ranks that are saved, just like back then.",
    "cta.download": "1.3GB ZIP download", "cta.discord": "Join the Discord",
    "status.title": "Server status",
    "state.off": "Sleeping", "state.starting": "Starting", "state.up": "Online", "state.stopping": "Stopping", "state.error": "Error", "state.unknown": "Unknown",
    "text.off": "The server sleeps when nobody plays. Wake it up with one click - and bring your friends.",
    "text.starting": "The server is starting. It takes a few minutes - this page updates by itself.",
    "text.up": "The server is online! Launch the game and pick it in the server list.",
    "text.stopping": "The server is saving and shutting down.",
    "text.error": "Something went wrong while starting. Try again or ask on Discord.",
    "text.unknown": "Couldn't read the server status.",
    "start.hint": "A quick check that you're not a bot, then the server starts.",
    "start.btn": "Wake the server", "start.sending": "Sending…", "start.ok": "Got it, the server is starting!",
    "start.captcha": "Check failed - try again.", "start.cooldown": "You already started it today. Try again in ~{h} h.",
    "start.running": "The server is already up or starting.", "start.budget": "This month's server budget is used up. Back next month - more on Discord.", "start.fail": "Request failed. Try again later.",
    "why.title": "Play FREE, with other FANS",
    "why.free": "Free and open source", "why.free.d": "No subscription, no ads, and all the code is open on GitHub.",
    "why.play": "Play now", "why.play.d": "The launcher sets everything up. Server asleep? One click here and it's up in minutes.",
    "why.ranks": "Ranks and medals", "why.ranks.d": "Just like in 2007, all features are restored. Your rank is saved.",
    "why.new": "New stuff", "why.new.d": "Thanks to new mod tools, we have new maps and seasons. Stay tuned!",
    "gal.title": "Gallery",
    "gal.intro": "Intro",
    "gal.arc": "Arc de Triomphe",
    "gal.china": "The China front", "gal.courtyard": "Courtyard under fire", "gal.hacking": "Battle Hacker at work",
    "gal.trooper": "Exoskeleton trooper", "gal.docks": "Firefight at the docks", "gal.tactical": "Tactical map and orders",
    "gal.menu": "The server list - full again",
    "gal.video": "Video coming soon",
    "join.title": "Join in two steps",
    "join.sub": "No fiddling with settings. The Rising2 launcher does the work.",
    "join.s1": "Download", "join.s1.d": "Get the game with the Rising2 launcher and install it. The launcher connects the game to the fan servers.",
    "join.s2": "Play", "join.s2.d": "Create an account on the login screen, pick a server from the list and jump in. Server asleep? Wake it here or with /start on Discord.",
    "about.title": "About the game",
    "about.p1": "Rising Eagle is a 2007 multiplayer first-person shooter set around 2040: the USA fights to keep its superpower status against China and the European Federation of Nations. You are a \"Super-Marine\" - an infantryman with an exoskeleton, advanced intelligence and command & control.",
    "about.p2": "Team-based and tactical, but also fast and furious - the balance is up to the players. Ranks and medals are saved again, so every fight counts.",
    "faq.title": "FAQ",
    "faq.q1": "Is this FREE?", "faq.a1": "Yes.",
    "faq.q2": "Why is the server sometimes asleep?",
    "faq.a2": "This project is funded by fans. To save costs, the game server shuts down automatically if nobody has played in the last 15 minutes, or at 5 AM every day. That way we can all afford to play again. All scores and ranks are saved until the next server start.",
    "faq.q3": "How do I contact you?", "faq.a3": "On Discord:",
    "footer.fan": "Unofficial, non-profit fan project. Rising Eagle is a trademark of Invasion Interactive. Rising2 is not affiliated with the rights holders.",
  },
};

let lang = "he"; // Hebrew by default, English on the toggle (remembered)
try { lang = localStorage.getItem("lang") === "en" ? "en" : "he"; } catch {}
let status = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const t = (k, a = {}) => (T[lang][k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => a[n] ?? "");

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$(".yt-empty span").forEach((el) => (el.textContent = t("gal.video")));
  $("#lang").textContent = lang === "he" ? "EN" : "עב";
  renderStatus();
  updateDots();
}

$("#lang").onclick = () => {
  lang = lang === "he" ? "en" : "he";
  try { localStorage.setItem("lang", lang); } catch {}
  applyLang();
};

$$("[data-discord]").forEach((a) => (a.href = CONFIG.discord));
$$("[data-download]").forEach((a) => (a.href = CONFIG.download));
window.onTurnstile = () => turnstile.render(".cf-turnstile", { sitekey: CONFIG.turnstileSiteKey, theme: "dark" });

// ---- background: dim grid, with light beams shooting along grid lines edge to edge ----
(() => {
  const cv = $("#bg"), cx = cv.getContext("2d");
  const G = 48;                          // grid cell, px
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, beams = [], last = performance.now(), nextSpawn = 0;

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function grid() {
    cx.strokeStyle = "rgba(60,255,140,0.045)";
    cx.lineWidth = 1;
    cx.beginPath();
    for (let x = 0.5; x < W; x += G) { cx.moveTo(x, 0); cx.lineTo(x, H); }
    for (let y = 0.5; y < H; y += G) { cx.moveTo(0, y); cx.lineTo(W, y); }
    cx.stroke();
  }
  function spawn() {
    const horiz = Math.random() < 0.5;
    const len = horiz ? W : H;
    const lines = Math.floor((horiz ? H : W) / G);
    beams.push({
      horiz,
      at: Math.floor(Math.random() * (lines + 1)) * G + 0.5,  // which grid line
      dir: Math.random() < 0.5 ? 1 : -1,                    // from which edge
      pos: 0, len,
      speed: 500 + Math.random() * 700,                     // px/s
      tail: 120 + Math.random() * 220,
      hue: Math.random() < 0.8 ? "70,255,140" : "180,255,220", // hacker green, some pale mint
    });
  }
  function draw(b) {
    const head = b.dir > 0 ? b.pos : b.len - b.pos;
    const tail = head - b.dir * b.tail;
    const [x1, y1, x2, y2] = b.horiz ? [tail, b.at, head, b.at] : [b.at, tail, b.at, head];
    const g = cx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, `rgba(${b.hue},0)`);
    g.addColorStop(1, `rgba(${b.hue},0.75)`);
    cx.strokeStyle = g;
    cx.lineWidth = 1.5;
    cx.beginPath(); cx.moveTo(x1, y1); cx.lineTo(x2, y2); cx.stroke();
    cx.fillStyle = `rgba(${b.hue},0.9)`;
    cx.shadowColor = `rgba(${b.hue},0.9)`; cx.shadowBlur = 10;
    cx.beginPath(); cx.arc(x2, y2, 1.8, 0, Math.PI * 2); cx.fill();
    cx.shadowBlur = 0;
  }
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    cx.clearRect(0, 0, W, H);
    grid();
    if (now > nextSpawn && beams.length < 7) { spawn(); nextSpawn = now + 250 + Math.random() * 900; }
    beams = beams.filter((b) => (b.pos += b.speed * dt) < b.len + b.tail);
    beams.forEach(draw);
    requestAnimationFrame(frame);
  }
  addEventListener("resize", () => { size(); if (calm) grid(); });
  size();
  if (calm) grid(); else requestAnimationFrame(frame);
})();

// ---- gallery ----
// YouTube: thumbnail first, the player loads only on click (youtube-nocookie).
$$("[data-yt]").forEach((f) => {
  const id = f.dataset.yt.trim();
  const box = document.createElement("div");
  if (!id) {
    box.className = "yt yt-empty";
    box.innerHTML = '<svg><use href="#i-play"/></svg><span></span>';
  } else {
    box.className = "yt";
    box.style.backgroundImage = `url(https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg)`;
    box.innerHTML = '<button type="button" aria-label="Play"><svg><use href="#i-play"/></svg></button>';
    box.querySelector("button").onclick = () => {
      box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1"
        allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="YouTube"></iframe>`;
    };
  }
  f.prepend(box);
});

// Image slider: arrows, dots, keys, and an auto-advance every 2 s that pauses while the
// visitor hovers, touches or focuses it.
const track = $(".track");
const slides = [...track.children];
const dots = $(".dots");
slides.forEach(() => dots.append(document.createElement("i")));

// The slide index comes from scrollLeft, not from on-screen rects: the PC is tilted in 3D, so
// bounding rects are skewed and picked the wrong slide. In RTL scrollLeft runs 0 .. -max.
let cur = 0;
const rtl = () => getComputedStyle(track).direction === "rtl";
function go(i) {
  cur = (i + slides.length) % slides.length;
  // scroll only the track (never the page), one slide = the track's width
  track.scrollTo({ left: (rtl() ? -1 : 1) * cur * track.clientWidth, behavior: "smooth" });
  updateDots();
  // the tower's HDD light flickers while the next picture "loads"
  const hdd = $(".tower .hdd");
  if (hdd) { hdd.classList.add("blink"); setTimeout(() => hdd.classList.remove("blink"), 120);
    setTimeout(() => hdd.classList.add("blink"), 200); setTimeout(() => hdd.classList.remove("blink"), 380); }
}
function updateDots() {
  [...dots.children].forEach((d, i) => d.classList.toggle("on", i === cur));
}
// "next" = forward in reading order (left-to-right in English, right-to-left in Hebrew); wraps around
const step = (n) => go(cur + n);
$(".slider .next").onclick = () => step(1);
$(".slider .prev").onclick = () => step(-1);
[...dots.children].forEach((d, i) => (d.onclick = () => go(i)));
// a swipe / scroll by hand: pick up the slide it settled on
let settle;
track.addEventListener("scroll", () => {
  clearTimeout(settle);
  settle = setTimeout(() => { cur = Math.round(Math.abs(track.scrollLeft) / track.clientWidth); updateDots(); }, 150);
}, { passive: true });
updateDots();
track.addEventListener("keydown", (e) => {
  const fwd = lang === "he" ? "ArrowLeft" : "ArrowRight", back = lang === "he" ? "ArrowRight" : "ArrowLeft";
  if (e.key === fwd) { e.preventDefault(); step(1); }
  if (e.key === back) { e.preventDefault(); step(-1); }
});

let paused = false, resume;
const gal = $(".gal-images");
const pause = () => { paused = true; clearTimeout(resume); };
const unpause = (ms = 0) => { clearTimeout(resume); resume = setTimeout(() => (paused = false), ms); };
gal.addEventListener("mouseenter", pause);
gal.addEventListener("mouseleave", () => unpause());
gal.addEventListener("focusin", pause);
gal.addEventListener("focusout", () => unpause());
gal.addEventListener("touchstart", pause, { passive: true });
gal.addEventListener("touchend", () => unpause(5000), { passive: true });
// The PC switches on (screen power-on effect, LEDs) the first time it scrolls into view;
// the slideshow only runs while it's on screen.
let pcVisible = false;
const pc = $(".pc");
new IntersectionObserver(([e]) => {
  pcVisible = e.isIntersecting;
  if (pcVisible) setTimeout(() => pc.classList.add("on"), 250);
}, { threshold: 0.35 }).observe(pc);
setInterval(() => { if (!paused && pcVisible && !document.hidden) step(1); }, 2000);

// Click the left / right part of the screen to go back / forward. Needed in 3D: Chrome's hit-testing
// on the tilted screen can give the click to the scrolling image strip instead of the arrow button.
// So the listener sits on the whole PC and checks where the click landed on the screen's outline.
const screenEl = $(".screen");
$(".pc").addEventListener("click", (e) => {
  if (e.target.closest(".nav, .dots")) return;
  const r = screenEl.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  if (fy < 0 || fy > 1 || fx < 0 || fx > 1 || (fx > 0.4 && fx < 0.6)) return;
  const right = fx >= 0.6;
  step(right === (lang !== "he") ? 1 : -1); // in Hebrew "next" is on the left
});

// The 3D desk faces you when the mouse is at its centre, and turns back to its resting angle
// (--rx0/--ry0 in style.css: a few degrees, from above and the right) toward the edges / mouse out.
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const scene = $(".scene");
  pc.addEventListener("pointermove", (e) => {
    const r = pc.getBoundingClientRect(), cs = getComputedStyle(scene);
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    const k = Math.min(1, Math.hypot(x, y) * 2);          // 0 at the centre, 1 at the edges
    scene.style.setProperty("--rx", `${(parseFloat(cs.getPropertyValue("--rx0")) * k).toFixed(2)}deg`);
    scene.style.setProperty("--ry", `${(parseFloat(cs.getPropertyValue("--ry0")) * k).toFixed(2)}deg`);
  });
  pc.addEventListener("pointerleave", () => { scene.style.removeProperty("--ry"); scene.style.removeProperty("--rx"); });
}

// ---- server status ----
function renderStatus() {
  const st = status ? status.state : "unknown";
  const pill = $("#pill");
  pill.className = `pill ${st}`;
  pill.textContent = t(`state.${st}`);
  $("#status-text").textContent = t(`text.${st}`);
  const fmt = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  $("#log").replaceChildren(...(status?.log || []).slice(-5).reverse().map((l) => {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = fmt.format(l.t);
    li.append(time, " ", l.msg);
    return li;
  }));
  $("#start").hidden = !(st === "off" || st === "error");
}

async function poll() {
  try {
    const r = await fetch(`${CONFIG.api}/status`, { cache: "no-store" });
    status = r.ok ? await r.json() : null;
  } catch { status = null; }
  renderStatus();
  const busy = status && (status.state === "starting" || status.state === "stopping");
  setTimeout(poll, busy ? 8000 : 60000);
}

$("#start").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#start-msg");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  msg.textContent = t("start.sending");
  try {
    const r = await fetch(`${CONFIG.api}/start`, { method: "POST", body: new FormData(e.target) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) msg.textContent = t("start.ok");
    else if (d.error === "captcha") msg.textContent = t("start.captcha");
    else if (d.error === "cooldown") msg.textContent = t("start.cooldown", { h: d.retryAfterHours });
    else if (d.error === "budget") msg.textContent = t("start.budget");
    else if (r.status === 409) msg.textContent = t("start.running");
    else msg.textContent = t("start.fail");
    if (r.ok) { status = { ...(status || { log: [] }), state: "starting" }; renderStatus(); setTimeout(poll, 4000); }
  } catch { msg.textContent = t("start.fail"); }
  btn.disabled = false;
  window.turnstile?.reset();
};

applyLang();
poll();
