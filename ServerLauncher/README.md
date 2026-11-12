# Rising2 Server Launcher

`r2launch.exe` starts the 2008 **official dedicated server** (`Official_DedicatedServer_131.exe`) and does the
clicking for you: types the server account into the login page, presses **Login**, picks a profile, and presses **Start**.
After a reboot or container restart, the server is up again on its own, with nobody at the keyboard.

The server exe is never changed. The launcher is a small Win32 program (user32 + msvcrt only) that runs on Windows and under Wine.

## How it works

The server's UI is a normal MFC dialog, not something drawn with Direct3D, so every field and button is a real window with a fixed control ID:

| Page | Control | ID |
|---|---|---|
| Login | nickname combo (edit inside) | 1027 |
| Login | password edit | 1028 |
| Login | Login button | 2 |
| Main | profile combo | 1016 |
| Main | status log edit | 1015 |
| Main | Start / Stop | 1087 / 3 |

The launcher looks the controls up by ID (it never uses screen positions), types with `WM_CHAR` and presses buttons with `BM_CLICK`.
It doesn't need focus, a visible desktop, or a real mouse. It copies the server's status lines to stdout (`[server] ...`) so they show up in `docker logs`.

Things that matter:

* **Type, don't set.** `WM_SETTEXT` on the password field doesn't stick. Typing it does.
* **Profile.** Start does nothing on `Default` (it has no server name). Pass `--profile`.
* **Login timing.** A press in the first seconds after the login page appears is ignored. The launcher waits 3 s, then retries every 15 s.
* **Under Wine:** you need OpenGL (Mesa) for level loading, because Wine turns Direct3D 9 into OpenGL. Also keep the game files on a Linux filesystem.
  A Windows folder mounted through Docker Desktop never finished loading the level.

## Use on Windows

Copy `bin/r2launch.exe` next to the server exe, then:

```bat
set R2_NICK=MyServerNick
set R2_PASS=secret
set R2_PROFILE=Eiffel_server
r2launch.exe --run
```

## Use in Docker (Wine)

```bash
docker compose up -d --build
docker logs -f rising2-dedicated
```

Set `R2_NICK`, `R2_PASS`, `R2_PROFILE` and the game volume in `docker-compose.yml`. The container exits when the server exits, or when it isn't running
within `--timeout` (default 600 s, exit code 2). `restart: unless-stopped` then brings it back.

Measured on Docker Desktop: container start to "server is ready" in about 47 s, using about 350 MB of RAM.

## Settings

Run `r2launch` with no arguments (or `--help`) to print this list. An option wins over its environment variable.
`--run` starts with environment variables only.

| Option | Env variable | Default | |
|---|---|---|---|
| `--nick NAME` | `R2_NICK` | | required |
| `--pass PASSWORD` | `R2_PASS` | | required; prefer the variable (options show in process lists) |
| `--profile NAME` | `R2_PROFILE` | | required; a `ProfileName` from `bin/DedicatedServer.ini`, not `Default` |
| `--exe PATH` | `R2_EXE` | server exe next to r2launch.exe | |
| `--retry-wait SEC` | `R2_RETRY_WAIT` | 10 | wait after any failed step, then redo it |
| `--timeout SEC` | `R2_TIMEOUT` | 600 | kill the server if it isn't running by then (0 = never) |
| `--start-delay MS` | `R2_START_DELAY` | 2000 | pause on the main dialog before Start |

Other options: `--set ID=TEXT` (set another main-dialog control, repeatable), `--auto-ok` (press OK on message boxes; on in Docker),
`--no-log`, `--attach PID`, `--dump`.

Missing or invalid settings stop the launcher before it starts the server, listing every problem (exit code 1).

## Checks and retries

Each step is checked before anything is pressed:

* **Login page:** the nickname box and Login button exist. Nickname and password are typed, then read back:
  the nickname must match, and the password must have the right length (password boxes don't give their text to other programs).
  Login must be visible and enabled.
* **Main dialog:** the profile list exists and has the profile. It is selected and read back. Any `--set` values are read back too.
  Start must be visible and enabled.

A failed check counts as a failure. So do a message box, and a Login or Start press that has no effect within `--retry-wait`.
After a failure the launcher waits `--retry-wait` seconds and redoes the whole step. This repeats until the server runs or `--timeout` is reached.
On Windows the first Login press is often ignored, so expect "failure 1" there. The retry handles it.

## Build

```bash
docker build -t rising2/mingw32 build
docker run --rm -v "$PWD/src:/src" -v "$PWD/bin:/out" rising2/mingw32
```
