// Cloudflare R2, the REAL server: LazyServer/docker-compose.yml + LazyServer/server.env -> server/ in the bucket. Also the website data (site/urls.json, site/s3files.json).
// (05a uploads the test server to the same two keys instead: whichever ran last is what the next VM gets.)
import fs from "node:fs";
import path from "node:path";
import { SRC, putServerFiles, putSiteFiles, deleteServerFiles } from "../../lib.mjs";
import { S, SITE } from "../../specs.mjs";

export default {
  title: "Cloudflare R2: upload the REAL game server's docker-compose.yml + .env",
  manual: ["the R2 bucket created by hand: dashboard > R2 > Create bucket (name = R2_BUCKET)",
    "on it, a lifecycle rule: Settings > Object lifecycle rules > prefix ratelimit/, delete after 1 day",
    "LazyServer/server.env filled in (copy of server.env.example: the game servers' GameSpy accounts, image names)",
    "this replaces the test server from 05a, if that was uploaded"],
  waitMin: 2,
  env: [S.CF_API_TOKEN("Account > Workers R2 Storage Edit"), S.CF_ACCOUNT_ID, S.R2_BUCKET, ...SITE],

  async deploy(E, R) {
    const lazy = path.join(SRC, "LazyServer");
    const envFile = process.env.SERVER_ENV_FILE || path.join(lazy, "server.env"); // (SERVER_ENV_FILE: only for testing this script)
    if (!fs.existsSync(envFile)) return R.fail("server.env", "LazyServer/server.env not found: copy server.env.example to server.env and fill it in");
    const envText = fs.readFileSync(envFile, "utf8");
    if (/change-me/.test(envText)) R.warn("server.env", "still has change-me passwords");
    if (/^R2_ADMIN_TOKEN=\s*$/m.test(envText)) R.warn("server.env", "R2_ADMIN_TOKEN is empty (make one: openssl rand -hex 16)");
    if (/^PUBLIC_IP=/m.test(envText)) R.warn("server.env", "has PUBLIC_IP: remove it, the VM adds its own");
    await putServerFiles(E, R, { "server/docker-compose.yml": path.join(lazy, "docker-compose.yml"), "server/.env": envFile }, "real server");
    putSiteFiles(E, R);
  },

  async undeploy(E, R) { await deleteServerFiles(E, R); },
};
