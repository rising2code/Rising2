# Rising2 Launcher

Pre-launcher for **Rising Eagle PC (2008)**, run by the Rising2 fan community.
It replaces [REExtraUtils](https://github.com/yonixw/REExtraUtils) and keeps all of its tools:

1. **Hosts / Redirect**: points the old GameSpy domains to this PC or to the fan server. Writes the same
   `# RisingEagle Game` marker as REExtraUtils, so redirects made by the old tool get cleaned up too.
2. **Duplicate client**: copies `RisingEagle.exe` to `_DUPNN.exe` with its own `.lNN` / `storage.dNN`.
3. **Undocumented info**: exe arguments, F11/server admin commands, Tcl console notes.
4. **Suggested links**: fetches `links.txt` from the latest REExtraUtils release, and falls back to a built-in copy.

Windows 10/11 only (it uses the WebView2 runtime that ships with Windows).
On Windows 7/8.1 it shows a "not supported" message and exits.

## How it is built

| Part | Where |
|---|---|
| Window, JS↔Go bridge, UAC helper | `main_windows.go` |
| Raw Win32 calls (frameless window, UAC, file dialog) | `win32_windows.go` |
| The actual work (hosts, duplicates, links), no Windows calls | `actions.go` + `actions_test.go` |
| UI (XP look, Matrix title bar, ripples) | `ui/` |
| Texts and default domain list | `data/` |
| Exe icon + manifest | `winres/` |

**Admin rights:** the launcher runs as a normal user. If Windows refuses a write (the hosts file, or a game
folder under Program Files), it re-runs itself as admin for that one action (`--elevated <job.json>`). That
shows a single UAC prompt, and the temp job files are deleted afterwards.

## Build

Needs only Docker:

```bash
docker build --build-arg VERSION=0.1.0 --output dist .
```

This runs the tests and writes `dist/Rising2_Launcher.exe` (~7 MB, no installer, no runtime to ship).

## Working on the UI

Open `ui/index.html` through any local web server (for example `python -m http.server` inside `ui/`). Without
the Go side, `app.js` uses a small mock backend, so pages and animations can be tweaked in a browser.
Run the exe with `--debug` to get DevTools (F12) inside the real window.

## Updating the links

Publish a plain-text `links.txt` (not RTF) on the latest REExtraUtils release. A line starting with `#` is a
heading, and URLs become clickable. `data/links.txt` is the offline copy built into the exe.
