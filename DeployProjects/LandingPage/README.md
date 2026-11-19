# Rising2 LandingPage

Static page for Cloudflare Pages: `index.html`, `style.css`, `app.js`, `assets/`.
No build step. Hebrew by default, English with the toggle (remembered per browser).

Sections: banner with **Direct download** + Discord, live server status, "why Rising2"
(direct download, open source, free, play now), gallery, how to join (3 steps), about.

* Live server status from `GET /api/status` (refreshes every 8 s while starting/stopping, else every minute).
* When the server is asleep: Cloudflare Turnstile + **Wake the server** -> `POST /api/start` (once a day per IP).

## To fill in

* `CONFIG` at the top of [app.js](app.js): Discord invite, download link, Turnstile site key
  (the default is Cloudflare's always-pass test key).
* Gallery videos in [index.html](index.html): `<figure data-yt="YOUTUBE_ID">` and its
  `<figcaption>`. An empty id shows a "video coming soon" slide; the player loads only on click
  (youtube-nocookie).
* More images: drop a JPG (16:9 looks best) in `assets/gallery/` and add a `<figure>`.
  The current ones come from the game guide PDF, the menu art and an in-game screenshot.

```powershell
npx wrangler pages deploy . --project-name rising2
```

Then add `rising2.net` and `www.rising2.net` as custom domains of the Pages project.
The worker's routes (`rising2.net/api/*`) sit in front of it, so the page calls the API on its own origin.
