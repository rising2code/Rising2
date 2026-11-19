"use strict";
// ---- settings: fill these in before deploying ----
const CONFIG = {
  api: "/api",                                  // CF-Worker route on the same domain
  discord: "https://discord.gg/REPLACE_ME",
  turnstileSiteKey: "1x00000000000000000000AA", // Cloudflare's always-pass test key; replace
};

const T = {
  he: {
    "nav.about": "המשחק", "nav.positions": "תפקידים", "nav.join": "איך מצטרפים",
    "hero.kicker": "קהילת מעריצים · שרתים חיים שוב",
    "hero.title": "שדה הקרב של 2040 חזר לאוויר",
    "hero.lead": "Rising2 מחזירה את Rising Eagle: Futuristic Infantry Warfare למשחק אונליין, עם שרתי GameSpy מדומים שנותנים את אותה הרגשה: התחברות עם חשבון, רשימת שרתים, דרגות ומדליות שנשמרות.",
    "cta.discord": "הצטרפו לדיסקורד", "cta.how": "איך מתחילים",
    "status.title": "מצב השרת", "status.addr": "כתובת:",
    "state.off": "כבוי", "state.starting": "עולה", "state.up": "פעיל", "state.stopping": "נכבה", "state.error": "תקלה", "state.unknown": "לא ידוע",
    "text.off": "השרת ישן כשאין שחקנים. אפשר להעיר אותו - פעם ביום לכל שחקן.",
    "text.starting": "השרת עולה. זה לוקח כמה דקות - הדף מתעדכן לבד.",
    "text.up": "השרת פעיל! היכנסו למשחק ובחרו אותו ברשימת השרתים.",
    "text.stopping": "השרת שומר נתונים ונכבה.",
    "text.error": "משהו השתבש בהפעלה. נסו שוב או כתבו בדיסקורד.",
    "text.unknown": "לא הצלחנו לקרוא את מצב השרת.",
    "start.hint": "אישור קצר שאתם לא בוט, ואז השרת מתחיל לעלות.",
    "start.btn": "הפעל את השרת", "start.sending": "שולח…", "start.ok": "הבקשה התקבלה, השרת עולה!",
    "start.captcha": "אימות נכשל - נסו שוב.", "start.cooldown": "כבר הפעלתם היום. נסו שוב בעוד ~{h} שעות.",
    "start.running": "השרת כבר פעיל או עולה.", "start.fail": "הבקשה נכשלה. נסו שוב מאוחר יותר.",
    "about.title": "על המשחק",
    "about.p1": "Rising Eagle הוא משחק יריות מגוף ראשון מרובה משתתפים משנת 2007, המתרחש בסביבות 2040: ארצות הברית נלחמת לשמור על מעמדה מול הרפובליקה העממית של סין ופדרציית האומות האירופית (EFN). אתם \"סופר-מרינס\" - חיילי רגלים עם שלד חיצוני (Exoskeleton), מודיעין ושליטה ובקרה מתקדמים.",
    "about.p2": "זה משחק עתידני, לא מדע בדיוני: הנשק והציוד מבוססים על הנחות סבירות. המשחק קבוצתי וטקטי, אבל גם מהיר ואגרסיבי - והאיזון בין השניים נקבע על ידי השחקנים עצמם.",
    "facts.year": "שנת הקרב", "facts.factions": "צבאות: ארה״ב, סין, EFN", "facts.platoon": "מחלקות × כיתות × לוחמים", "facts.positions": "תפקידים במחלקה",
    "pos.title": "התפקידים במחלקה",
    "pos.trooper": "לוחם (Trooper)", "pos.trooper.d": "חייל הרגלים של העתיד: שלד חיצוני ומגוון נשק, מרובי סער ועד טילים מונחים.",
    "pos.sniper": "צלף", "pos.sniper.d": "אמנות ההסתתרות: רובה צלפים שקט בקוטר קטן, או רובה נגד ציוד (AMR) עצום - ציד מרחוק ומאחורי מחסה.",
    "pos.hacker": "האקר קרב", "pos.hacker.d": "החייל של העתיד באמת: פורץ למערכות המחשוב של האויב ומשתלט עליהן.",
    "pos.abe": "מהנדס קרב משוריין (ABE)", "pos.abe.d": "חמוש ומשוריין בכבדות: מקלעים, תותחים אוטומטיים, מטולי רימונים, רקטות וטילים. כוח האש של המחלקה.",
    "pos.sl": "מפקד כיתה", "pos.sl.d": "מפקד על עד ארבעה לוחמים ומתאם אותם לביצוע פקודות מפקד המחלקה.",
    "pos.pl": "מפקד מחלקה", "pos.pl.d": "המפקד של הכוח כולו: מכוון את הכיתות ומחפש את הדרך היעילה ביותר להערים על האויב.",
    "rank.title": "הדרגות נשמרות שוב",
    "rank.p": "השרת שלנו מממש מחדש את שירות התחרויות של GameSpy, כך שנקודות המיומנות, ההיסטוריה והדרגה שלכם נשמרות בין משחקים - מטוראי ועד רב-סרן. מעל Master Chief מתקדמים רק כמפקדי כיתה או מחלקה.",
    "rank.medals": "מדליות: DSM, ESM, Medal of Valor ופרסי תפקיד כמו Master Hacker ו-Master Sniper.",
    "join.title": "איך מצטרפים",
    "join.s1": "1. מתקינים את המשחק", "join.s1.d": "קישור להתקנה ולתיקונים נמצא בדיסקורד.",
    "join.s2": "2. מפנים לשרת המעריצים", "join.s2.d": "משגר Rising2 מעדכן את קובץ ה-hosts כך שהמשחק יתחבר אלינו במקום ל-GameSpy שנסגר.",
    "join.s3": "3. יוצרים חשבון", "join.s3.d": "במסך Add / Remove account: כינוי של 3-20 תווים, אימייל וסיסמה, בלי רווחים.",
    "join.s4": "4. מתחברים לשרת", "join.s4.d": "Servers list ← Internet Game ← בוחרים שרת ← Connect. אם השרת כבוי, מפעילים אותו מהדף הזה או עם ‎/start בדיסקורד.",
    "lazy.title": "למה השרת לפעמים כבוי?",
    "lazy.p": "זה פרויקט של מעריצים בלי תקציב. השרת עולה כשמישהו מבקש, נשמר כל רבע שעה, ונכבה לבד אחרי חצי שעה בלי שחקנים - ובכל מקרה ב-05:00 בבוקר.",
    "footer.fan": "פרויקט מעריצים לא רשמי ללא מטרות רווח. Rising Eagle הוא סימן מסחרי של Invasion Interactive. אין קשר בין Rising2 לבעלי הזכויות.",
  },
  en: {
    "nav.about": "The game", "nav.positions": "Positions", "nav.join": "How to join",
    "hero.kicker": "Fan community · servers are live again",
    "hero.title": "The 2040 battlefield is back online",
    "hero.lead": "Rising2 brings Rising Eagle: Futuristic Infantry Warfare back online, with mock GameSpy servers that give the same feel: account login, the server list, and ranks and medals that are saved again.",
    "cta.discord": "Join the Discord", "cta.how": "Get started",
    "status.title": "Server status", "status.addr": "Address:",
    "state.off": "Off", "state.starting": "Starting", "state.up": "Online", "state.stopping": "Stopping", "state.error": "Error", "state.unknown": "Unknown",
    "text.off": "The server sleeps when nobody plays. You can wake it up - once a day per player.",
    "text.starting": "The server is starting. It takes a few minutes - this page updates by itself.",
    "text.up": "The server is online! Launch the game and pick it in the server list.",
    "text.stopping": "The server is saving and shutting down.",
    "text.error": "Something went wrong while starting. Try again or ask on Discord.",
    "text.unknown": "Couldn't read the server status.",
    "start.hint": "A quick check that you're not a bot, then the server starts.",
    "start.btn": "Start the server", "start.sending": "Sending…", "start.ok": "Got it, the server is starting!",
    "start.captcha": "Check failed - try again.", "start.cooldown": "You already started it today. Try again in ~{h} h.",
    "start.running": "The server is already up or starting.", "start.fail": "Request failed. Try again later.",
    "about.title": "About the game",
    "about.p1": "Rising Eagle is a 2007 multiplayer first-person shooter set around 2040: the USA fights to keep its superpower status against the People's Republic of China and the new European Federation of Nations (EFN). You are a \"Super-Marine\" - an infantryman with an exoskeleton, advanced intelligence and command & control.",
    "about.p2": "It's futuristic, not science fiction: the weapons and gear are based on plausible assumptions. Play is team-based and tactical, but also fast and furious - the balance between the two is up to the players.",
    "facts.year": "the year of the war", "facts.factions": "armies: USA, China, EFN", "facts.platoon": "platoons × squads × soldiers", "facts.positions": "positions in a platoon",
    "pos.title": "Positions in a platoon",
    "pos.trooper": "Trooper", "pos.trooper.d": "The regular infantryman of the future: an exoskeleton and a wide range of weapons, from assault rifles to guided missiles.",
    "pos.sniper": "Sniper", "pos.sniper.d": "The art of subterfuge: a silenced small-caliber rifle or a massive Anti-Material Rifle (AMR), hunting from afar and from cover.",
    "pos.hacker": "Battle Hacker", "pos.hacker.d": "The true soldier of the future: hacks into hostile IT systems and seizes control of them.",
    "pos.abe": "Armored Battle Engineer", "pos.abe.d": "Heavily armed and armored: machine guns, auto-cannons, grenade launchers, rockets and missiles. The platoon's supporting fire.",
    "pos.sl": "Squad Leader", "pos.sl.d": "Commands up to four soldiers and coordinates them to carry out the Platoon Leader's orders.",
    "pos.pl": "Platoon Leader", "pos.pl.d": "Commands the whole force: directs the squads and looks for the best way to outwit the enemy.",
    "rank.title": "Your rank is saved again",
    "rank.p": "Our server re-implements GameSpy's competition service, so your skill points, history and rank carry over between games - from Private to Major. Past Master Chief you only advance as a Squad or Platoon Leader.",
    "rank.medals": "Medals: DSM, ESM, Medal of Valor, plus position awards like Master Hacker and Master Sniper.",
    "join.title": "How to join",
    "join.s1": "1. Install the game", "join.s1.d": "The installer and patches are linked on Discord.",
    "join.s2": "2. Point it at the fan server", "join.s2.d": "The Rising2 launcher updates your hosts file so the game talks to us instead of the closed GameSpy.",
    "join.s3": "3. Create an account", "join.s3.d": "In Add / Remove account: a 3-20 character nickname, an email and a password, no spaces.",
    "join.s4": "4. Connect", "join.s4.d": "Servers list → Internet Game → pick a server → Connect. If it's off, start it from this page or with /start on Discord.",
    "lazy.title": "Why is the server sometimes off?",
    "lazy.p": "This is a no-budget fan project. The server starts on request, saves every 15 minutes, and shuts itself down after half an hour with no players - and at 05:00 (Israel time) anyway.",
    "footer.fan": "Unofficial, non-profit fan project. Rising Eagle is a trademark of Invasion Interactive. Rising2 is not affiliated with the rights holders.",
  },
};

let lang = "he"; // Hebrew by default, English on the toggle (remembered)
try { lang = localStorage.getItem("lang") === "en" ? "en" : "he"; } catch {}
let status = null;

const $ = (s) => document.querySelector(s);
const t = (k, a = {}) => (T[lang][k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => a[n] ?? "");

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $("#lang").textContent = lang === "he" ? "EN" : "עב";
  renderStatus();
}

$("#lang").onclick = () => {
  lang = lang === "he" ? "en" : "he";
  try { localStorage.setItem("lang", lang); } catch {}
  applyLang();
};

document.querySelectorAll("[data-discord]").forEach((a) => (a.href = CONFIG.discord));
window.onTurnstile = () => turnstile.render(".cf-turnstile", { sitekey: CONFIG.turnstileSiteKey, theme: "dark" });

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
