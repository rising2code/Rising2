"use strict";
// UI strings. Hebrew is the default language, English the fallback.
// {name} placeholders are filled from args. Message codes from Go (Msg.Code) live here too.
const I18N = {
  he: {
    "lang.name": "עברית", "lang.short": "HE", "lang.tip": "שפה: עברית\nלחץ למעבר לאנגלית",
    "win.zoomOut": "טקסט קטן יותר (Ctrl -)", "win.zoomIn": "טקסט גדול יותר (Ctrl +)",
    "win.min": "מזער", "win.close": "סגור",
    "nav.tools": "כלים", "nav.knowledge": "ידע",
    "nav.hosts": "הפניית שרת (hosts)", "nav.dup": "שכפול הלקוח",
    "nav.info": "מידע לא מתועד", "nav.links": "קישורים מומלצים",
    "who.admin": "🛡 רץ כמנהל מערכת", "who.user": "👤 משתמש רגיל<br>(יבקש הרשאות מנהל רק כשצריך)",
    "who.webview": "WebView2 {v}", "who.launcher": "גרסת המשגר {v}",

    "hosts.title": "הפניית GameSpy לשרת המעריצים",
    "hosts.hint": "מפנה את כתובות GameSpy הישנות לשרת שתבחר, על ידי עריכת הקובץ {path}. Windows יבקש הרשאות מנהל כשצריך.",
    "hosts.pointTo": "הפנה את הכתובות אל", "hosts.local": "המחשב הזה (127.0.0.1)", "hosts.custom": "כתובת IP של שרת המעריצים:",
    "hosts.domains": "כתובות", "hosts.reset": "איפוס לברירת מחדל",
    "hosts.apply": "החל הפניה!", "hosts.remove": "הסר הפניה",
    "hosts.checking": "בודק…", "hosts.active": "פעיל: {n} כתובות ← {ip}", "hosts.none": "אין הפניה",
    "hosts.cantRead": "לא ניתן לקרוא את hosts",
    "hosts.needIP": "קודם הקלד את כתובת ה-IP של שרת המעריצים.",
    "hosts.resetDone": "רשימת הכתובות אופסה לברירת המחדל ({n}).",
    "hosts.applying": "מפנה {n} כתובות אל {ip}", "hosts.removing": "מסיר הפניה",
    "hosts.applied": "{n} כתובות הופנו אל {ip}.", "hosts.removed": "כל ההפניות של Rising Eagle הוסרו.",

    "dup.title": "שכפול הלקוח",
    "dup.hint": "יוצר עותקים של RisingEagle.exe שאפשר להריץ במקביל על אותו מחשב (לבדיקות מרובות משתתפים). כל עותק כותב קובץ לוג {log} וקובץ {storage} משלו.",
    "dup.path": "הנתיב ל-RisingEagle.exe (אפשר לגרור לכאן מהסייר)", "dup.browse": "עיון…", "dup.options": "אפשרויות",
    "dup.count": "כמה עותקים (1-99)", "dup.log": "שינוי {from} ל-{to}", "dup.storage": "שינוי {from} ל-{to}",
    "dup.always": "(תמיד)", "dup.alwaysTip": "חובה, כדי שהעותקים לא יתנגשו על אותם קבצים",
    "dup.create": "צור עותקים!", "dup.needExe": "קודם בחר את RisingEagle.exe.",
    "dup.creating": "יוצר {n} עותקים",
    "dup.dropped": "נבחר: {path}", "dup.dropNotExe": "{name} אינו קובץ exe", "dup.dropNoPath": "לא ניתן לקרוא את הנתיב של {name}, השתמש ב'עיון…'", "dup.done": "נוצרו {n} עותקים ליד {exe} (‎_DUP00.exe עד {last}).",

    "info.title": "מידע לא מתועד", "info.args": "פרמטרים ל-RisingEagle.exe", "info.admin": "F11 / ניהול שרת",
    "info.tcl": "קונסולת Tcl", "info.tclExample": "דוגמת Tcl",

    "links.title": "קישורים מומלצים", "links.refresh": "רענן",
    "links.online": "העדכני מ-GitHub releases", "links.offline": "עותק לא מקוון · פתח GitHub releases",
    "links.tip": "פתח את {url}", "links.fetching": "מוריד קישורים של הקהילה",
    "links.updated": "הקישורים עודכנו.", "links.fallback": "אין חיבור, מוצגים הקישורים המובנים ({err})",

    "task.reutils": "RE_Utils",
    "net.on": "חיבור מקומי\nמחובר", "net.off": "חיבור מקומי\nכבל הרשת מנותק",
    "con.boot": "RISING2 LAUNCHER // מאתחל", "con.ready": "WebView2 {v} תקין · hosts: {path}",
    "con.zoom": "גודל טקסט {pct}%", "con.lang": "השפה הוחלפה לעברית", "con.bootFail": "האתחול נכשל: {err}",
    "con.error": "שגיאה: {err}",

    "err.domain": "כתובת לא תקינה: {domain}", "err.ip": "כתובת ה-IP לא תקינה: {ip}",
    "err.noDomains": "רשימת הכתובות ריקה", "err.count": "מספר העותקים חייב להיות בין 1 ל-99",
    "err.notGameExe": "{text} לא נמצא בקובץ. האם זה RisingEagle.exe?",
    "err.uacDeclined": "לא אושרו הרשאות מנהל, לא שונה דבר", "err.helper": "תהליך המנהל נכשל (קוד יציאה {code})",
    "err.system": "{detail}",
  },
  en: {
    "lang.name": "English", "lang.short": "EN", "lang.tip": "Language: English\nClick to switch to Hebrew",
    "win.zoomOut": "Smaller text (Ctrl -)", "win.zoomIn": "Bigger text (Ctrl +)",
    "win.min": "Minimize", "win.close": "Close",
    "nav.tools": "Tools", "nav.knowledge": "Knowledge",
    "nav.hosts": "Hosts / Redirect", "nav.dup": "Duplicate Client",
    "nav.info": "Undocumented Info", "nav.links": "Suggested Links",
    "who.admin": "🛡 Running as admin", "who.user": "👤 Normal user<br>(asks for admin only when needed)",
    "who.webview": "WebView2 {v}", "who.launcher": "Launcher {v}",

    "hosts.title": "Redirect GameSpy to the fan server",
    "hosts.hint": "Points the old GameSpy domains to a server of your choice by editing {path}. Windows will ask for admin permission when needed.",
    "hosts.pointTo": "Point the domains to", "hosts.local": "This PC (127.0.0.1)", "hosts.custom": "Fan server IP:",
    "hosts.domains": "Domains", "hosts.reset": "reset to default",
    "hosts.apply": "Apply redirect!", "hosts.remove": "Remove redirect",
    "hosts.checking": "checking…", "hosts.active": "active: {n} domains → {ip}", "hosts.none": "not redirected",
    "hosts.cantRead": "can't read hosts",
    "hosts.needIP": "Type the fan server IP first.",
    "hosts.resetDone": "Domain list reset to default ({n}).",
    "hosts.applying": "Redirecting {n} domains to {ip}", "hosts.removing": "Removing redirect",
    "hosts.applied": "Redirected {n} domains to {ip}.", "hosts.removed": "Removed all Rising Eagle redirects.",

    "dup.title": "Duplicate client",
    "dup.hint": "Makes copies of RisingEagle.exe that can run side by side on this PC (for multiplayer testing). Each copy writes its own {log} log and {storage}.",
    "dup.path": "RisingEagle.exe path (or drag it here from Explorer)", "dup.browse": "Browse…", "dup.options": "Options",
    "dup.count": "How many copies (1-99)", "dup.log": "Change {from} to {to}", "dup.storage": "Change {from} to {to}",
    "dup.always": "(always)", "dup.alwaysTip": "Required, so the copies don't fight over the same files",
    "dup.create": "Create duplicates!", "dup.needExe": "Choose RisingEagle.exe first.",
    "dup.creating": "Creating {n} copies",
    "dup.dropped": "Selected: {path}", "dup.dropNotExe": "{name} is not an .exe", "dup.dropNoPath": "Can't read the path of {name}, use Browse…", "dup.done": "Created {n} copies next to {exe} (_DUP00.exe - {last}).",

    "info.title": "Undocumented info", "info.args": "RisingEagle.exe args", "info.admin": "F11 / Server admin",
    "info.tcl": "Tcl console", "info.tclExample": "Tcl example",

    "links.title": "Suggested links", "links.refresh": "Refresh",
    "links.online": "latest from GitHub releases", "links.offline": "offline copy · open GitHub releases",
    "links.tip": "Open {url}", "links.fetching": "Fetching community links",
    "links.updated": "Links updated.", "links.fallback": "Offline, showing built-in links ({err})",

    "task.reutils": "RE_Utils",
    "net.on": "Local Area Connection\nConnected", "net.off": "Local Area Connection\nA network cable is unplugged",
    "con.boot": "RISING2 LAUNCHER // booting", "con.ready": "WebView2 {v} OK · hosts: {path}",
    "con.zoom": "Text size {pct}%", "con.lang": "Language switched to English", "con.bootFail": "BOOT FAILED: {err}",
    "con.error": "ERROR: {err}",

    "err.domain": "Not a valid domain: {domain}", "err.ip": "IP is not valid: {ip}",
    "err.noDomains": "The domain list is empty", "err.count": "Count must be 1-99",
    "err.notGameExe": "{text} not found in the exe. Is this RisingEagle.exe?",
    "err.uacDeclined": "Admin permission was declined, nothing changed", "err.helper": "Admin helper failed (exit code {code})",
    "err.system": "{detail}",
  },
};

let LANG = "he";
try { LANG = localStorage.getItem("lang") || "he"; } catch {}
if (!I18N[LANG]) LANG = "he";

// t("hosts.applied", {n: 3, ip: "1.2.3.4"}). Also accepts a Go Msg {code, args}.
function t(key, args = {}) {
  if (key && typeof key === "object") return t(key.code, key.args || {});
  const s = I18N[LANG][key] ?? I18N.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in args ? String(args[k]) : m));
}
