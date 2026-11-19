# Rising2 LandingPage

Static page for Cloudflare Pages: `index.html`, `style.css`, `app.js`, `assets/logo.png`.
No build step. Hebrew by default, English with the toggle (remembered per browser).

* Banner, game info (setting, platoon positions, ranks/medals - from the game guide), how to join.
* Live server status from `GET /api/status` (refreshes every 8 s while starting/stopping, else every minute).
* When the server is off: Cloudflare Turnstile + **Start** -> `POST /api/start` (once a day per IP).

Before deploying, set `CONFIG` at the top of [app.js](app.js): the Discord invite and the
Turnstile site key (the default is Cloudflare's always-pass test key).

```powershell
npx wrangler pages deploy . --project-name rising2
```

Then add `rising2.net` and `www.rising2.net` as custom domains of the Pages project.
The worker's routes (`rising2.net/api/*`) sit in front of it, so the page calls the API on its own origin.
