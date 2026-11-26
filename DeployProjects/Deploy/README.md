# Rising2 Deploy

Setting the whole flow up on your own accounts, one small step at a time. Each step owns one
thing, has its **own** `step.env` (nothing is shared between steps), and has:

* **deploy**: creates / updates what it owns. It checks first, so it's safe to run again, and it
  **waits** for the provider to catch up (OVH can take minutes before a change shows) instead of failing.
* **undeploy**: removes what that step created, so a failed deploy can start clean.
* **check**: only validates its `step.env`: what's missing, and values that don't look right.

Everything runs in a small Docker image (node + wrangler), so nothing is installed on your machine.
The code is mounted, not baked in: edit and rerun, no rebuild.

## By hand first

* **OVH project**: Public Cloud > Create a project in the OVH panel. Its id (32 hex, under its name and in
  the page URL) is `OVH_PROJECT` in steps 02, 08 and 10.
* **OVH API keys**: two keys, made on **your account's OVH site** (`createToken` page below). A key only
  works on the site that made it, and `OVH_ENDPOINT` must be that site:

  | Your console is | Make keys at | `OVH_ENDPOINT` |
  |---|---|---|
  | `console.ca.ovhcloud.com` (OVHcloud Canada) | https://ca.api.ovh.com/createToken/ | `https://ca.api.ovh.com/1.0` |
  | `www.ovh.com/manager` / EU | https://eu.api.ovh.com/createToken/ | `https://eu.api.ovh.com/1.0` |

  Validity: Unlimited. One rule per line (method in the dropdown, path in the box, "+" for the next):

  **Deploy key** (steps 02 and 10):
  ```
  GET     /auth/currentCredential
  GET     /cloud/project
  GET     /cloud/project/*
  POST    /cloud/project/*
  DELETE  /cloud/project/*
  ```
  **Worker key** (step 08; the worker on Cloudflare uses it). Write your real project id where it says
  `PROJECT_ID` - OVH matches the text literally, a leftover placeholder makes every call "not allowed":
  ```
  GET     /cloud/project/PROJECT_ID/*
  POST    /cloud/project/PROJECT_ID/instance
  DELETE  /cloud/project/PROJECT_ID/instance/*
  ```
  Leave "Restricted IPs" empty on the worker key (Cloudflare's addresses change). Each key's three values
  (Application Key, Application Secret, Consumer Key) go together into `OVH_APP_KEY`, `OVH_APP_SECRET`,
  `OVH_CONSUMER_KEY` of its steps - never mix values from two keys.
  OVH bills in your account's currency (CAD for OVHcloud Canada): set `MAX_COST_*` in that currency.
* **R2 bucket**: dashboard > R2 > Create bucket (`R2_BUCKET`), then on it Settings > Object lifecycle rules:
  prefix `ratelimit/`, delete after 1 day (keeps the rate-limit marks from piling up).

## Steps

| # | Step | Owns | Needs from earlier steps | Prints for later steps |
|---|---|---|---|---|
| 02 | `ovh-setup` | the region(s) enabled (default `OVH_REGION=DE1,GRA11`, tried in order); checks flavors, image(s) (default `Debian 12 - Docker`, then `Debian 12`), cost API | `OVH_PROJECT` (by hand) | - |
| 03 | `cloudflare-dns` | `ip.<domain>` (A, grey) and `*.<domain>` -> ip | - | `CF_ZONE_ID`, `CF_ACCOUNT_ID` |
| 05 | `cloudflare-r2-populate` | `server/docker-compose.yml` + `server/.env` in R2, from `../LazyServer` | `CF_ACCOUNT_ID` | - |
| 06 | `cloudflare-turnstile` | the captcha widget | `CF_ACCOUNT_ID` | `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET` |
| 07 | `cloudflare-pages` | the landing page, `<domain>` + `www` and their DNS | `CF_ACCOUNT_ID`, `TURNSTILE_SITEKEY` | - |
| 08 | `cloudflare-worker` | the worker on `<domain>/api/*` + its secrets | `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `TURNSTILE_SECRET`, `OVH_PROJECT`, `DISCORD_PUBLIC_KEY` (optional) | - |
| 09 | `discord` | `/start /status /stop` + the interactions URL | worker live (08) | `DISCORD_PUBLIC_KEY` |
| 10 | `test-loop` | one real start -> up -> stop -> deleted (a few minutes of VM time) | everything | - |

Values you make yourself and must keep the **same** in two places:

| Value | Make it with | Goes in |
|---|---|---|
| `SHARED_TOKEN` | `.\Deploy\step.ps1 token` (64 hex) | 08 and 10 |
| `DISCORD_PUBLIC_KEY` | Developer Portal > General Information (09 also prints it) | 08 |

Each `steps/<step>/step.env.example` lists, for every setting, what it's for and **what a real value
looks like** (prefix, length, hex or not), plus what to do by hand before that step.
Values from earlier steps are printed and saved in `out/<step>/outputs.env`.

## Run

From `DeployProjects/` (the image builds on first use):

```powershell
.\Deploy\step.ps1 list
```

```powershell
Copy-Item Deploy\steps\03-cloudflare-dns\step.env.example Deploy\steps\03-cloudflare-dns\step.env
```

```powershell
.\Deploy\step.ps1 cloudflare-dns check
```

```powershell
.\Deploy\step.ps1 cloudflare-dns deploy
```

```powershell
.\Deploy\step.ps1 cloudflare-dns undeploy
```

(`./Deploy/step.sh` does the same from bash.) The step number can be left out. Reports land in
`out/<step>/deploy.report.md` / `undeploy.report.md` (+ `.json`). `step.env` files and `out/` are git-ignored.

Optional in any `step.env`: `WAIT_MIN` (how long to wait for the provider) and `DRY_RUN=1`
(wrangler commands are printed instead of run; the API calls still happen).

## What undeploy keeps

* **05** removes only its two files, never the saved game state (`configs_sync/`); the bucket itself is yours to manage.
* **10** asks the worker to stop the VM and, if it doesn't go within 10 min, deletes it through the
  OVH API, so a broken test can't keep billing.

## Testing the steps themselves

`CF_API_BASE`, `OVH_ENDPOINT`, `DISCORD_API_BASE`, `WORKER_TEST_URL`, `SITE_CHECK_URL` and
`SERVER_ENV_FILE` can point the steps at stand-ins; with those and `DRY_RUN=1` every step's deploy,
a second deploy, and undeploy were run against fake Cloudflare / OVH / Discord APIs, the real worker
under `wrangler dev`, and a fake VM.
