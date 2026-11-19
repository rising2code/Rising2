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
    "start.running": "השרת כבר פעיל או עולה.", "start.fail": "הבקשה נכשלה. נסו שוב מאוחר יותר.",
    "why.title": "משחקים בחינם, עם מעריצים אחרים",
    "why.free": "חינם וקוד פתוח", "why.free.d": "בלי מנוי ובלי פרסומות, וכל הקוד פתוח ב-GitHub.",
    "why.play": "משחקים עכשיו", "why.play.d": "המשגר מגדיר הכול לבד. השרת ישן? לחיצה אחת כאן והוא עולה בתוך דקות.",
    "why.ranks": "דרגות ומדליות", "why.ranks.d": "בדיוק כמו ב-2007, כל הפיצ'רים חזרו. הדרגה שלכם נשמרת.",
    "why.new": "חדש", "why.new.d": "בזכות כלי מודים חדשים יש לנו מפות ועונות חדשות. הישארו מעודכנים!",
    "gal.title": "גלריה",
    "gal.intro": "הקדמה",
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
    "start.running": "The server is already up or starting.", "start.fail": "Request failed. Try again later.",
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

function current() {
  const mid = track.getBoundingClientRect().left + track.clientWidth / 2;
  let best = 0, dist = Infinity;
  slides.forEach((s, i) => {
    const r = s.getBoundingClientRect();
    const d = Math.abs(r.left + r.width / 2 - mid);
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}
function go(i) {
  // Scroll only the track, by the on-screen distance to the slide's centre: works the same in
  // LTR and RTL, and never moves the page (scrollIntoView would, while the gallery is off-screen).
  const s = slides[(i + slides.length) % slides.length].getBoundingClientRect();
  const tr = track.getBoundingClientRect();
  track.scrollBy({ left: s.left + s.width / 2 - (tr.left + tr.width / 2), behavior: "smooth" });
}
function updateDots() {
  const c = current();
  [...dots.children].forEach((d, i) => d.classList.toggle("on", i === c));
}
// "next" = forward in reading order (left-to-right in English, right-to-left in Hebrew); wraps around
const step = (n) => go(current() + n);
$(".slider .next").onclick = () => step(1);
$(".slider .prev").onclick = () => step(-1);
[...dots.children].forEach((d, i) => (d.onclick = () => go(i)));
track.addEventListener("scroll", () => requestAnimationFrame(updateDots), { passive: true });
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
setInterval(() => { if (!paused && !document.hidden) step(1); }, 2000);

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
    else if (r.status === 409) msg.textContent = t("start.running");
    else msg.textContent = t("start.fail");
    if (r.ok) { status = { ...(status || { log: [] }), state: "starting" }; renderStatus(); setTimeout(poll, 4000); }
  } catch { msg.textContent = t("start.fail"); }
  btn.disabled = false;
  window.turnstile?.reset();
};

applyLang();
poll();
