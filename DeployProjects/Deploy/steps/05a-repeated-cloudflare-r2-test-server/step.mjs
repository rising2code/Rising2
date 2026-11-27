// Cloudflare R2, the TEST server: LazyServer/test-server/{docker-compose.yml,test.env} -> server/ in the bucket. Also the website data (site/urls.json, site/s3files.json).
// A "hello" page + an empty player list (so idle shutdown works) + Dozzle for container logs over SSH,
// to test the whole VM loop before the real game server compose is final. 05b replaces it with the real one.
import path from "node:path";
import { SRC, putServerFiles, putSiteFiles, deleteServerFiles } from "../../lib.mjs";
import { S, SITE } from "../../specs.mjs";

export default {
  title: "Cloudflare R2: upload the TEST server (hello page + Dozzle logs) as the VM's compose",
  manual: ["the R2 bucket created by hand: dashboard > R2 > Create bucket (name = R2_BUCKET)",
    "on it, a lifecycle rule: Settings > Object lifecycle rules > prefix ratelimit/, delete after 1 day",
    "to see the logs: SSH_PUBLIC_KEY in step 08, then ssh -L 8080:localhost:8080 root@ip.<domain> and open http://localhost:8080",
    "without the game files: GAME_ZIP_URL=none in step 08"],
  waitMin: 2,
  env: [S.CF_API_TOKEN("Account > Workers R2 Storage Edit"), S.CF_ACCOUNT_ID, S.R2_BUCKET, ...SITE],

  async deploy(E, R) {
    const dir = path.join(SRC, "LazyServer", "test-server");
    await putServerFiles(E, R, { "server/docker-compose.yml": path.join(dir, "docker-compose.yml"), "server/.env": path.join(dir, "test.env") }, "test server");
    putSiteFiles(E, R);
    R.info("next VM", "starts the test server; run 05b to switch back to the real one");
  },

  async undeploy(E, R) { await deleteServerFiles(E, R); },
};
