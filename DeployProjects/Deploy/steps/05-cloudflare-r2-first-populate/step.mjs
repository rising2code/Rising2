// Cloudflare R2, the website's data (one-time): site/urls.json (the page's links) and
// site/s3files.json (the public resource archive list). The page only gets them from the worker
// after its captcha, so crawlers never see them. Edit them later right in R2 (dashboard > R2 >
// the bucket > site/) - this step won't overwrite them unless OVERWRITE=yes.
import fs from "node:fs";
import path from "node:path";
import { F, SRC, BUILD, DRY, wrangler, checkR2Bucket, r2Exists } from "../../lib.mjs";
import { S } from "../../specs.mjs";

const KEYS = { urls: "site/urls.json", files: "site/s3files.json" };

export default {
  title: "Cloudflare R2: the website's links + archive list (site/urls.json, site/s3files.json)",
  manual: ["the R2 bucket created by hand: dashboard > R2 > Create bucket (name = R2_BUCKET)",
    "the archive list: DeployProjects/SiteData/s3files.json (empty to start with)"],
  waitMin: 2,
  env: [
    S.CF_API_TOKEN("Account > Workers R2 Storage Edit"), S.CF_ACCOUNT_ID, S.R2_BUCKET,
    { name: "DISCORD_INVITE", f: F.invite, about: "the Discord buttons' link" },
    { name: "GITHUB_URL", f: F.url, def: "https://github.com/rising2code/Rising2", about: "the GitHub link" },
    { name: "DOWNLOAD_URL", f: F.url, about: "the \"1.3GB ZIP download\" buttons' link" },
    { name: "OVERWRITE", f: F.yesno, required: true, def: "no", about: "yes = replace the files already in R2 (no = keep them, e.g. after editing them in R2)" },
  ],

  async deploy(E, R) {
    await checkR2Bucket(E, R);
    const urls = Object.fromEntries(Object.entries({ discord: E.DISCORD_INVITE, github: E.GITHUB_URL, download: E.DOWNLOAD_URL }).filter(([, v]) => v));
    for (const k of ["discord", "download"]) if (!urls[k]) R.warn(k, "not set: the page hides that button");
    const filesSrc = path.join(SRC, "SiteData", "s3files.json");
    const files = JSON.parse(fs.readFileSync(filesSrc, "utf8")); // a broken JSON stops here, not on the site
    if (!Array.isArray(files.files)) throw new Error("SiteData/s3files.json needs a \"files\" list");
    const bad = files.files.filter((f) => !f || typeof f.key !== "string" || !f.key);
    if (bad.length) throw new Error(`SiteData/s3files.json: ${bad.length} entr${bad.length === 1 ? "y has" : "ies have"} no "key"`);

    fs.mkdirSync(BUILD, { recursive: true });
    const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
    const put = (key, obj, what) => {
      if (E.OVERWRITE !== "yes" && r2Exists(E, key)) return R.ok(key, "already in R2 - kept (OVERWRITE=yes replaces it)");
      const f = path.join(BUILD, path.basename(key));
      fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
      wrangler(["r2", "object", "put", `${E.R2_BUCKET}/${key}`, "--file", f, "--content-type", "application/json"], w);
      R.ok(key, `${DRY ? "(dry run) " : ""}uploaded: ${what}`);
    };
    put(KEYS.urls, urls, Object.keys(urls).join(", ") || "no links");
    put(KEYS.files, files, `${files.files.length} file${files.files.length === 1 ? "" : "s"}`);
  },

  async undeploy(E, R) {
    await checkR2Bucket(E, R);
    const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
    for (const key of Object.values(KEYS)) {
      try { wrangler(["r2", "object", "delete", `${E.R2_BUCKET}/${key}`], w); R.ok(key, "deleted"); }
      catch (e) { R.warn(key, e.message); }
    }
  },
};
