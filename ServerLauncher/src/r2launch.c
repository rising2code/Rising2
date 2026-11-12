/*
 * Rising2 server launcher (r2launch.exe)
 *
 * Starts the Rising Eagle dedicated server (an MFC dialog app from 2008) and
 * does what a person would do in its window: type the nickname and password,
 * press Login, pick a profile, press Start. Plain Win32 (user32 + msvcrt), so
 * it runs on Windows and under Wine.
 *
 * Nothing in the server is patched. The launcher finds the server's controls
 * by their dialog IDs and sends them the same messages a keyboard and mouse
 * would: WM_CHAR for typing, BM_CLICK for buttons.
 *
 * Control IDs (from the exe's dialog resources, checked on the running server):
 *   login page (dialog 152): combo 1027 nickname (edit inside), edit 1028 password, button 2 "Login"
 *   main dialog (102):       combo 1016 profile, edit 1015 status log, button 1087 "Start", button 3 "Stop"
 *
 * Things learned the hard way:
 *   - WM_SETTEXT on the password edit does not stick (the field stays empty);
 *     typing the characters with WM_CHAR does.
 *   - Start does nothing on the "Default" profile (no server name), so pick a
 *     real profile with --profile.
 *   - GetWindowText on another process's controls returns their creation
 *     caption, not the current text; read text with WM_GETTEXT instead.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#define ID_LOGIN_NICK   1027
#define ID_LOGIN_PASS   1028
#define ID_LOGIN_BUTTON 2
#define ID_PROFILE      1016
#define ID_STATUS_LOG   1015
#define ID_START        1087
#define ID_STOP         3

#define MAX_SET 16

static struct {
    char exe[MAX_PATH];
    char args[1024];
    char nick[128];
    char pass[128];
    char profile[128];
    int  set_id[MAX_SET];
    char set_text[MAX_SET][128];
    int  nset;
    int  timeout;       /* seconds to reach "running", 0 = forever */
    int  start_delay;   /* ms to wait on the main dialog before pressing Start */
    int  retry_wait;    /* seconds to wait after any failed step before trying it again */
    int  run;           /* --run: start with settings from the environment only */
    int  dump;          /* only print the window tree, press nothing */
    int  auto_ok;       /* press OK on message boxes that pop up before Start */
    int  echo_log;      /* copy the server's status log lines to stdout */
    DWORD attach;       /* drive an already running server instead of starting one */
} cfg;

static DWORD g_pid;

static void logmsg(const char *fmt, ...)
{
    SYSTEMTIME t; va_list ap;
    GetLocalTime(&t);
    printf("%02d:%02d:%02d [r2launch] ", t.wHour, t.wMinute, t.wSecond);
    va_start(ap, fmt); vprintf(fmt, ap); va_end(ap);
    printf("\n");
    fflush(stdout);
}

/* Current text of a control in another process. */
static int text_of(HWND h, char *buf, int size)
{
    DWORD_PTR n = 0;
    buf[0] = 0;
    if (!SendMessageTimeoutA(h, WM_GETTEXT, (WPARAM)size, (LPARAM)buf, SMTO_ABORTIFHUNG, 2000, &n))
        return 0;
    buf[size - 1] = 0;
    return (int)n;
}

/* ---- window search ------------------------------------------------------ */

typedef struct { int id; HWND found; } FindCtl;

static BOOL CALLBACK find_child_cb(HWND h, LPARAM lp)
{
    FindCtl *f = (FindCtl *)lp;
    if (GetDlgCtrlID(h) == f->id && IsWindowVisible(h)) { f->found = h; return FALSE; }
    return TRUE;
}

static BOOL CALLBACK find_top_cb(HWND top, LPARAM lp)
{
    FindCtl *f = (FindCtl *)lp;
    DWORD pid = 0;
    GetWindowThreadProcessId(top, &pid);
    if (pid != g_pid || !IsWindowVisible(top)) return TRUE;
    EnumChildWindows(top, find_child_cb, lp);
    return f->found == NULL;
}

/* A visible control with this ID anywhere in the server's windows. */
static HWND find_ctl(int id)
{
    FindCtl f; f.id = id; f.found = NULL;
    EnumWindows(find_top_cb, (LPARAM)&f);
    return f.found;
}

/* ---- input -------------------------------------------------------------- */

static void click(HWND btn)
{
    PostMessageA(btn, BM_CLICK, 0, 0);
}

/* Clear an edit box and type text into it, one WM_CHAR per character. */
static void type_text(HWND ed, const char *text)
{
    SendMessageA(ed, WM_SETTEXT, 0, (LPARAM)"");
    for (; *text; text++)
        SendMessageA(ed, WM_CHAR, (WPARAM)(unsigned char)*text, 1);
}

/* Combo box: pick the item with this text (exact, then prefix) and tell the
 * parent, as a user picking from the list would. If the item is not there and
 * the combo has an edit box, type the text instead. Returns 1 if picked. */
static int set_combo(HWND cb, const char *text)
{
    LRESULT i = SendMessageA(cb, CB_FINDSTRINGEXACT, (WPARAM)-1, (LPARAM)text);
    if (i == CB_ERR) i = SendMessageA(cb, CB_FINDSTRING, (WPARAM)-1, (LPARAM)text);
    if (i != CB_ERR) {
        SendMessageA(cb, CB_SETCURSEL, (WPARAM)i, 0);
        SendMessageA(GetParent(cb), WM_COMMAND, MAKEWPARAM(GetDlgCtrlID(cb), CBN_SELCHANGE), (LPARAM)cb);
        return 1;
    }
    {
        HWND ed = FindWindowExA(cb, NULL, "Edit", NULL);
        if (ed) type_text(ed, text);
    }
    return 0;
}

static void list_combo(HWND cb)
{
    int i, n = (int)SendMessageA(cb, CB_GETCOUNT, 0, 0);
    for (i = 0; i < n; i++) {
        char item[256] = "";
        if (SendMessageA(cb, CB_GETLBTEXTLEN, i, 0) < (LRESULT)sizeof item)
            SendMessageA(cb, CB_GETLBTEXT, i, (LPARAM)item);
        logmsg("  profile: %s", item);
    }
}

static void set_any(HWND h, const char *text)
{
    char cls[64] = "";
    GetClassNameA(h, cls, sizeof cls);
    if (!lstrcmpiA(cls, "ComboBox")) set_combo(h, text);
    else type_text(h, text);
}

/* ---- message boxes ------------------------------------------------------ */

/* A message box: a visible top-level #32770 of the server with an OK button
 * and a static text directly on it (the server's own dialogs have neither). */
typedef struct { HWND box; char text[512]; } MsgBox;

static BOOL CALLBACK msgbox_cb(HWND top, LPARAM lp)
{
    MsgBox *m = (MsgBox *)lp;
    DWORD pid = 0;
    char cls[32] = "";
    HWND st;
    GetWindowThreadProcessId(top, &pid);
    if (pid != g_pid || !IsWindowVisible(top)) return TRUE;
    GetClassNameA(top, cls, sizeof cls);
    if (strcmp(cls, "#32770")) return TRUE;
    st = GetDlgItem(top, 0xFFFF);
    if (!st || !GetDlgItem(top, IDOK)) return TRUE;
    m->box = top;
    text_of(st, m->text, sizeof m->text);
    return FALSE;
}

/* ---- dump --------------------------------------------------------------- */

static void dump_tree(HWND h, int depth)
{
    char cls[64] = "", txt[128] = "";
    HWND c;
    GetClassNameA(h, cls, sizeof cls);
    text_of(h, txt, sizeof txt);
    printf("%*s%p id=%d cls=%s vis=%d en=%d text=\"%s\"\n", depth * 2, "", (void *)h,
           GetDlgCtrlID(h), cls, IsWindowVisible(h) ? 1 : 0, IsWindowEnabled(h) ? 1 : 0, txt);
    for (c = GetWindow(h, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT))
        if (IsWindowVisible(c)) dump_tree(c, depth + 1);
}

static BOOL CALLBACK dump_top_cb(HWND top, LPARAM lp)
{
    DWORD pid = 0;
    (void)lp;
    GetWindowThreadProcessId(top, &pid);
    if (pid == g_pid && IsWindowVisible(top)) dump_tree(top, 1);
    return TRUE;
}

/* ---- status log echo ---------------------------------------------------- */

/* The main dialog's status box (edit 1015) gets one line per event, e.g.
 * "... Level "Dynamics" was loaded, server is ready." Print new lines. */
static void echo_status(void)
{
    static char last[65536];
    static int last_len;
    static char buf[65536];
    HWND h = find_ctl(ID_STATUS_LOG);
    int n;
    char *p, *line;
    if (!h) return;
    n = text_of(h, buf, sizeof buf);
    if (n <= 0 || (n == last_len && !memcmp(buf, last, n))) return;
    /* New text is whatever follows the old text; if the box was cleared or
     * trimmed, print all of it. */
    p = (n > last_len && last_len > 0 && !memcmp(buf, last, last_len)) ? buf + last_len : buf;
    for (line = strtok(p, "\r\n"); line; line = strtok(NULL, "\r\n"))
        if (*line) { printf("[server] %s\n", line); }
    fflush(stdout);
    text_of(h, last, sizeof last);
    last_len = (int)strlen(last);
}


/* ---- checks ------------------------------------------------------------- */

/* Each check logs what is wrong and returns 0, so a step can stop at the
 * first problem and be retried after --retry-wait. */

static int check_button(HWND b, const char *what)
{
    if (!b)                  { logmsg("check failed: %s button not found", what); return 0; }
    if (!IsWindowVisible(b)) { logmsg("check failed: %s button is hidden", what); return 0; }
    if (!IsWindowEnabled(b)) { logmsg("check failed: %s button is disabled", what); return 0; }
    return 1;
}

static int check_exists(HWND h, const char *what)
{
    if (!h) { logmsg("check failed: %s not found", what); return 0; }
    return 1;
}

/* The control's text must equal want (case-insensitive) and not be empty. */
static int check_text(HWND h, const char *want, const char *what)
{
    char got[256];
    text_of(h, got, sizeof got);
    if (!got[0])              { logmsg("check failed: %s is empty after setting it", what); return 0; }
    if (lstrcmpiA(got, want)) { logmsg("check failed: %s is '%s', expected '%s'", what, got, want); return 0; }
    return 1;
}

/* Password edits do not hand their text to other processes, so check the length. */
static int check_length(HWND h, int want, const char *what)
{
    DWORD_PTR n = 0;
    SendMessageTimeoutA(h, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG, 2000, &n);
    if (n == 0)         { logmsg("check failed: %s is empty after typing it", what); return 0; }
    if ((int)n != want) { logmsg("check failed: %s has %d characters, expected %d", what, (int)n, want); return 0; }
    return 1;
}

/* ---- steps -------------------------------------------------------------- */

/* Login page: fill nickname and password, check both, press Login. */
static int step_login(HWND pass)
{
    HWND page = GetParent(pass);
    HWND nick = GetDlgItem(page, ID_LOGIN_NICK);
    HWND btn  = GetDlgItem(page, ID_LOGIN_BUTTON);

    if (!check_exists(nick, "login nickname box (1027)")) return 0;
    if (!check_button(btn, "Login")) return 0;

    set_combo(nick, cfg.nick);
    type_text(pass, cfg.pass);
    Sleep(200);
    if (!check_text(nick, cfg.nick, "nickname")) return 0;
    if (!check_length(pass, (int)strlen(cfg.pass), "password")) return 0;
    if (!check_button(btn, "Login")) return 0;

    click(btn);
    return 1;
}

/* Main dialog: select the profile and --set values, check them, press Start. */
static int step_start(HWND start)
{
    int i;
    HWND prof = find_ctl(ID_PROFILE);

    if (!check_exists(prof, "profile list (1016)")) return 0;
    if (!set_combo(prof, cfg.profile)) {
        static int listed;
        if (!listed) {
            logmsg("check failed: profile '%s' is not in the list; the server has:", cfg.profile);
            list_combo(prof);
            listed = 1;
        } else {
            logmsg("check failed: profile '%s' is not in the list", cfg.profile);
        }
        return 0;
    }
    Sleep(200);
    if (!check_text(prof, cfg.profile, "profile")) return 0;
    logmsg("profile '%s' selected", cfg.profile);

    for (i = 0; i < cfg.nset; i++) {
        char what[64];
        HWND c = find_ctl(cfg.set_id[i]);
        snprintf(what, sizeof what, "control %d", cfg.set_id[i]);
        if (!check_exists(c, what)) return 0;
        set_any(c, cfg.set_text[i]);
        if (!check_text(c, cfg.set_text[i], what)) return 0;
        logmsg("set %s to '%s'", what, cfg.set_text[i]);
    }

    if (cfg.start_delay > 0) Sleep(cfg.start_delay);
    if (!check_button(start, "Start")) return 0;
    click(start);
    return 1;
}

/* ---- options ------------------------------------------------------------ */

static void usage(void)
{
    printf(
"r2launch - starts the Rising Eagle dedicated server and presses Login and Start for you\n"
"\n"
"Usage:\n"
"  r2launch [options] [-- server arguments]\n"
"  r2launch --run              start with settings from environment variables only\n"
"  r2launch --help             this text (also shown when run with no arguments)\n"
"\n"
"Settings (option, or environment variable; an option wins over the variable):\n"
"  --nick NAME        R2_NICK         server's GameSpy nickname                  required\n"
"  --pass PASSWORD    R2_PASS         its password; prefer the variable,         required\n"
"                                     options show up in process lists\n"
"  --profile NAME     R2_PROFILE      profile to start: a ProfileName from       required\n"
"                                     bin/DedicatedServer.ini (not \"Default\")\n"
"  --exe PATH         R2_EXE          server exe (default: Official_DedicatedServer_131.exe\n"
"                                     next to r2launch.exe)\n"
"  --retry-wait SEC   R2_RETRY_WAIT   wait after any failed step, then redo it   (default 10)\n"
"  --timeout SEC      R2_TIMEOUT      kill the server if not running by then     (default 600, 0 = never)\n"
"  --start-delay MS   R2_START_DELAY  pause on the main dialog before Start      (default 2000)\n"
"\n"
"Other options:\n"
"  --set ID=TEXT      also set main-dialog control ID (combo or edit) to TEXT; repeatable\n"
"  --auto-ok          press OK on message boxes that pop up before the server runs\n"
"  --no-log           do not copy the server's status lines ([server] ...) to stdout\n"
"  --attach PID       drive a server that is already running instead of starting one\n"
"  --dump             only print the server's visible windows every 5 s, press nothing\n"
"\n"
"What it does, each step checked before moving on:\n"
"  login page:  type nickname + password, read both back (not empty, right value),\n"
"               check Login exists and is enabled, press it\n"
"  main dialog: select the profile, read it back, check Start exists and is enabled,\n"
"               press it; done when Start greys out and Stop lights up\n"
"  A failed check, a message box, or a press with no effect within --retry-wait\n"
"  counts as a failure: wait --retry-wait seconds and redo the step.\n"
"\n"
"Exit codes: the server's own exit code once it ran; 2 if it never got running\n"
"(timeout, or it quit first); 1 for bad settings or a launcher error.\n");
}

static void copy_opt(char *dst, size_t size, const char *src) { snprintf(dst, size, "%s", src); }

static int num_opt(const char *name, const char *v, int min)
{
    char *end;
    long n = strtol(v, &end, 10);
    if (!*v || *end || n < min) { fprintf(stderr, "r2launch: %s must be a number >= %d, got '%s'\n", name, min, v); exit(1); }
    return (int)n;
}

static void load_options(int argc, char **argv)
{
    int i;
    char *p;
    char self[MAX_PATH];

    if (argc < 2) { usage(); exit(0); }

    GetModuleFileNameA(NULL, self, sizeof self);
    p = strrchr(self, '\\');
    if (p) p[1] = 0; else self[0] = 0;
    snprintf(cfg.exe, sizeof cfg.exe, "%sOfficial_DedicatedServer_131.exe", self);
    cfg.timeout = 600;
    cfg.start_delay = 2000;
    cfg.retry_wait = 10;
    cfg.echo_log = 1;

    if ((p = getenv("R2_EXE")) && *p)         copy_opt(cfg.exe, sizeof cfg.exe, p);
    if ((p = getenv("R2_NICK")))              copy_opt(cfg.nick, sizeof cfg.nick, p);
    if ((p = getenv("R2_PASS")))              copy_opt(cfg.pass, sizeof cfg.pass, p);
    if ((p = getenv("R2_PROFILE")))           copy_opt(cfg.profile, sizeof cfg.profile, p);
    if ((p = getenv("R2_RETRY_WAIT")) && *p)  cfg.retry_wait  = num_opt("R2_RETRY_WAIT", p, 1);
    if ((p = getenv("R2_TIMEOUT")) && *p)     cfg.timeout     = num_opt("R2_TIMEOUT", p, 0);
    if ((p = getenv("R2_START_DELAY")) && *p) cfg.start_delay = num_opt("R2_START_DELAY", p, 0);

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (!strcmp(a, "--")) {
            for (i++; i < argc; i++) {
                strncat(cfg.args, " ", sizeof cfg.args - strlen(cfg.args) - 1);
                strncat(cfg.args, argv[i], sizeof cfg.args - strlen(cfg.args) - 1);
            }
            break;
        }
        if (!strcmp(a, "--help") || !strcmp(a, "-h") || !strcmp(a, "/?")) { usage(); exit(0); }
        if (!strcmp(a, "--run"))     { cfg.run = 1; continue; }
        if (!strcmp(a, "--dump"))    { cfg.dump = 1; continue; }
        if (!strcmp(a, "--auto-ok")) { cfg.auto_ok = 1; continue; }
        if (!strcmp(a, "--no-log"))  { cfg.echo_log = 0; continue; }
        if (i + 1 >= argc) { fprintf(stderr, "r2launch: missing value for %s (see --help)\n", a); exit(1); }
        if      (!strcmp(a, "--exe"))         copy_opt(cfg.exe, sizeof cfg.exe, argv[++i]);
        else if (!strcmp(a, "--nick"))        copy_opt(cfg.nick, sizeof cfg.nick, argv[++i]);
        else if (!strcmp(a, "--pass"))        copy_opt(cfg.pass, sizeof cfg.pass, argv[++i]);
        else if (!strcmp(a, "--profile"))     copy_opt(cfg.profile, sizeof cfg.profile, argv[++i]);
        else if (!strcmp(a, "--attach"))      cfg.attach      = (DWORD)num_opt(a, argv[++i], 1);
        else if (!strcmp(a, "--retry-wait"))  cfg.retry_wait  = num_opt(a, argv[++i], 1);
        else if (!strcmp(a, "--timeout"))     cfg.timeout     = num_opt(a, argv[++i], 0);
        else if (!strcmp(a, "--start-delay")) cfg.start_delay = num_opt(a, argv[++i], 0);
        else if (!strcmp(a, "--set")) {
            const char *v = argv[++i];
            const char *eq = strchr(v, '=');
            if (!eq || eq == v || !eq[1] || cfg.nset >= MAX_SET) { fprintf(stderr, "r2launch: bad --set '%s', expected ID=TEXT\n", v); exit(1); }
            cfg.set_id[cfg.nset] = atoi(v);
            copy_opt(cfg.set_text[cfg.nset], sizeof cfg.set_text[0], eq + 1);
            cfg.nset++;
        }
        else { fprintf(stderr, "r2launch: unknown option %s (see --help)\n", a); exit(1); }
    }

    /* Required settings: check them all and report every missing one at once. */
    if (!cfg.dump) {
        int bad = 0;
        if (!cfg.nick[0])    { fprintf(stderr, "r2launch: nickname is not set (--nick or R2_NICK)\n"); bad = 1; }
        if (!cfg.pass[0])    { fprintf(stderr, "r2launch: password is not set (--pass or R2_PASS)\n"); bad = 1; }
        if (!cfg.profile[0]) { fprintf(stderr, "r2launch: profile is not set (--profile or R2_PROFILE)\n"); bad = 1; }
        else if (!lstrcmpiA(cfg.profile, "Default")) {
            fprintf(stderr, "r2launch: profile 'Default' has no server name and will not start; pick another\n"); bad = 1;
        }
        if (bad) { fprintf(stderr, "run 'r2launch --help' for all settings\n"); exit(1); }
    }
    if (!cfg.attach && GetFileAttributesA(cfg.exe) == INVALID_FILE_ATTRIBUTES) {
        fprintf(stderr, "r2launch: server exe not found: %s (--exe or R2_EXE)\n", cfg.exe);
        exit(1);
    }
}

/* ---- main --------------------------------------------------------------- */

enum { ST_LOGIN, ST_LOGIN_SENT, ST_MAIN, ST_START_SENT, ST_RUNNING };

static int   g_failures;
static DWORD g_wait_until;

/* A step failed: say so, and do nothing until --retry-wait has passed. */
static void fail(const char *why)
{
    g_failures++;
    g_wait_until = GetTickCount() + (DWORD)cfg.retry_wait * 1000;
    logmsg("%s - retrying in %d s (failure %d)", why, cfg.retry_wait, g_failures);
}

int main(int argc, char **argv)
{
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    char cmd[2048], dir[MAX_PATH], *slash;
    DWORD t0, exit_code = 0, pressed_at = 0, login_seen = 0, retry_ms;
    int state = ST_LOGIN, logins = 0, starts = 0;
    HWND last_box = NULL;

    load_options(argc, argv);
    retry_ms = (DWORD)cfg.retry_wait * 1000;

    snprintf(dir, sizeof dir, "%s", cfg.exe);
    slash = strrchr(dir, '\\');
    if (slash) *slash = 0; else GetCurrentDirectoryA(sizeof dir, dir);
    snprintf(cmd, sizeof cmd, "\"%s\"%s", cfg.exe, cfg.args);

    if (!cfg.dump)
        logmsg("settings: nick='%s' password=%d chars profile='%s' retry-wait=%ds timeout=%ds start-delay=%dms",
               cfg.nick, (int)strlen(cfg.pass), cfg.profile, cfg.retry_wait, cfg.timeout, cfg.start_delay);

    memset(&si, 0, sizeof si); si.cb = sizeof si;
    memset(&pi, 0, sizeof pi);
    if (cfg.attach) {
        pi.dwProcessId = cfg.attach;
        pi.hProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_TERMINATE, FALSE, cfg.attach);
        if (!pi.hProcess) { logmsg("cannot open pid %lu, error %lu", cfg.attach, GetLastError()); return 1; }
        logmsg("attached to pid %lu", cfg.attach);
    } else {
        logmsg("starting %s (in %s)", cmd, dir);
        if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
            logmsg("CreateProcess failed, error %lu", GetLastError());
            return 1;
        }
    }
    g_pid = pi.dwProcessId;
    logmsg("server pid %lu", g_pid);
    t0 = GetTickCount();

    for (;;) {
        DWORD now;
        HWND h;
        MsgBox mb;

        if (WaitForSingleObject(pi.hProcess, 500) == WAIT_OBJECT_0) break;
        now = GetTickCount();

        if (cfg.dump) {
            static DWORD last;
            if (!last || now - last >= 5000) {
                last = now;
                logmsg("visible windows of pid %lu:", g_pid);
                EnumWindows(dump_top_cb, 0);
                fflush(stdout);
            }
            continue;
        }

        if (cfg.echo_log) echo_status();
        if (state == ST_RUNNING) continue;

        if (cfg.timeout && now - t0 > (DWORD)cfg.timeout * 1000) {
            logmsg("server not running after %d s (%d failures), killing it; its windows were:", cfg.timeout, g_failures);
            EnumWindows(dump_top_cb, 0);
            TerminateProcess(pi.hProcess, 2);
            WaitForSingleObject(pi.hProcess, 10000);
            return 2;
        }

        /* Message boxes: log each once and press OK if asked to. A box before
         * the server runs means something went wrong: count a failure. */
        memset(&mb, 0, sizeof mb);
        EnumWindows(msgbox_cb, (LPARAM)&mb);
        if (mb.box) {
            if (mb.box != last_box) {
                logmsg("message box: \"%s\"", mb.text);
                last_box = mb.box;
                if (cfg.auto_ok) { click(GetDlgItem(mb.box, IDOK)); logmsg("pressed OK"); }
                if (state == ST_LOGIN_SENT) state = ST_LOGIN;
                if (state == ST_START_SENT) state = ST_MAIN;
                fail("message box appeared");
            }
            continue;
        }
        last_box = NULL;

        if ((LONG)(now - g_wait_until) < 0) continue;   /* waiting after a failure */

        /* Main dialog: Start is visible. */
        h = find_ctl(ID_START);
        if (h) {
            HWND stop = find_ctl(ID_STOP);
            if (!IsWindowEnabled(h) && stop && IsWindowEnabled(stop)) {
                logmsg("server is running (after %d failure%s)", g_failures, g_failures == 1 ? "" : "s");
                state = ST_RUNNING;
                continue;
            }
            if (state < ST_MAIN) { logmsg("logged in, main dialog is up"); state = ST_MAIN; }
            if (state == ST_START_SENT) {
                if (now - pressed_at < retry_ms) continue;   /* give Start time to act */
                state = ST_MAIN;
                fail("Start had no effect");
                continue;
            }
            if (step_start(h)) {
                starts++;
                pressed_at = GetTickCount();
                state = ST_START_SENT;
                logmsg("pressed Start (%d)", starts);
            } else {
                fail("main dialog step failed");
            }
            continue;
        }

        /* Login page: the password edit is visible. */
        h = find_ctl(ID_LOGIN_PASS);
        if (!h) continue;                         /* still loading, or between pages */
        if (!login_seen) login_seen = now;
        /* The page shows before the server is ready for it; a press in the
         * first seconds is ignored, so let it settle first. */
        if (now - login_seen < 3000) continue;
        if (state == ST_LOGIN_SENT) {
            if (now - pressed_at < retry_ms) continue;   /* give Login time to act */
            state = ST_LOGIN;
            fail("still on the login page after pressing Login");
            continue;
        }
        if (step_login(h)) {
            logins++;
            pressed_at = GetTickCount();
            state = ST_LOGIN_SENT;
            logmsg("pressed Login as '%s' (%d)", cfg.nick, logins);
        } else {
            fail("login step failed");
        }
    }

    GetExitCodeProcess(pi.hProcess, &exit_code);
    logmsg("server exited with code %lu", exit_code);
    if (pi.hThread) CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return state == ST_RUNNING ? (int)exit_code : 2;
}
