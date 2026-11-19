// Cloudflare R2: the VM's files - LazyServer/docker-compose.yml and LazyServer/server.env -> server/ in the bucket.
import fs from "node:fs";
import path from "node:path";
import { SRC, BUILD, DRY, wrangler } from "../../lib.mjs";
import { S } from "../../specs.mjs";

const KEYS = ["server/docker-compose.yml", "server/.env"];

export default {
  title: "Cloudflare R2: upload the VM's docker-compose.yml + .env",
  manual: ["04-cloudflare-r2-create done",
    "LazyServer/server.env filled in (copy of server.env.example: the game servers' GameSpy accounts, image names)"],
  waitMin: 2,
  env: [S.CF_API_TOKEN("Account > Workers R2 Storage Edit"), S.CF_ACCOUNT_ID, S.R2_BUCKET],

  async deploy(E, R) {
    const lazy = path.join(SRC, "LazyServer");
    const envFile = process.env.SERVER_ENV_FILE || path.join(lazy, "server.env"); // (SERVER_ENV_FILE: only for testing this script)
    if (!fs.existsSync(envFile)) return R.fail("server.env", "LazyServer/server.env not found: copy server.env.example to server.env and fill it in");
    const envText = fs.readFileSync(envFile, "utf8");
    if (/change-me/.test(envText)) R.warn("server.env", "still has change-me passwords");
    if (/^R2_ADMIN_TOKEN=\s*$/m.test(envText)) R.warn("server.env", "R2_ADMIN_TOKEN is empty (make one: openssl rand -hex 16)");
    if (/^PUBLIC_IP=/m.test(envText)) R.warn("server.env", "has PUBLIC_IP: remove it, the VM adds its own");

    const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
    const files = { "server/docker-compose.yml": path.join(lazy, "docker-compose.yml"), "server/.env": envFile };
    for (const [key, file] of Object.entries(files)) {
      wrangler(["r2", "object", "put", `${E.R2_BUCKET}/${key}`, "--file", file, "--remote"], w);
      // read it back and compare, so "uploaded" means it's really there
      if (!DRY) {
        const back = path.join(BUILD, "readback");
        wrangler(["r2", "object", "get", `${E.R2_BUCKET}/${key}`, "--file", back, "--remote"], w);
        const same = fs.readFileSync(back).equals(fs.readFileSync(file));
        fs.rmSync(back);
        if (!same) { R.fail(key, "uploaded, but what R2 returns differs"); continue; }
      }
      R.ok(key, `uploaded from LazyServer/${path.basename(file)} (${fs.statSync(file).size} bytes)`);
    }
  },

  // Removes only these two files - never the saved game state (configs_sync/) or the rate-limit marks.
  async undeploy(E, R) {
    const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
    for (const key of KEYS) {
      try { wrangler(["r2", "object", "delete", `${E.R2_BUCKET}/${key}`, "--remote"], w); R.ok(key, "deleted"); }
      catch (e) { R.warn(key, e.message); }
    }
  },
};
