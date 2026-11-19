// Cloudflare R2: the bucket, and the rule that deletes ratelimit/ objects after a day.
import { cfApi, waitFor } from "../../lib.mjs";
import { S } from "../../specs.mjs";

export default {
  title: "Cloudflare R2: create the bucket + the 1-day ratelimit/ rule",
  manual: ["R2 enabled on the account (dashboard > R2 > Purchase / enable - the free tier still asks once)",
    "an API token with Account > Workers R2 Storage Edit"],
  waitMin: 5,
  env: [S.CF_API_TOKEN("Account > Workers R2 Storage Edit"), S.CF_ACCOUNT_ID, S.R2_BUCKET],

  async deploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const A = `/accounts/${E.CF_ACCOUNT_ID}/r2/buckets`;
    const exists = async () => ((await cf("GET", A)).buckets || []).some((b) => b.name === E.R2_BUCKET);
    if (await exists()) R.ok("bucket", `${E.R2_BUCKET} exists`);
    else {
      await cf("POST", A, { name: E.R2_BUCKET });
      await waitFor(`bucket ${E.R2_BUCKET}`, exists, { minutes: E.WAIT_MIN, everySec: 5 });
      R.ok("bucket", `created ${E.R2_BUCKET}`);
    }
    try {
      await cf("PUT", `${A}/${E.R2_BUCKET}/lifecycle`, { rules: [{
        id: "ratelimit-1d", enabled: true, conditions: { prefix: "ratelimit/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
      }] });
      R.ok("lifecycle", "ratelimit/ objects are deleted after 1 day");
    } catch (e) {
      R.warn("lifecycle", `${e.message} - set it by hand: R2 > ${E.R2_BUCKET} > Settings > Object lifecycle rules: prefix ratelimit/, delete after 1 day`);
    }
  },

  // Only an empty bucket can be deleted: this never deletes saved game state (configs_sync/).
  // Run 05-cloudflare-r2-populate undeploy first; anything else left in it you remove by hand on purpose.
  async undeploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const A = `/accounts/${E.CF_ACCOUNT_ID}/r2/buckets`;
    if (!((await cf("GET", A)).buckets || []).some((b) => b.name === E.R2_BUCKET)) return R.ok("bucket", `${E.R2_BUCKET} doesn't exist`);
    try {
      await cf("DELETE", `${A}/${E.R2_BUCKET}`);
      R.ok("bucket", `deleted ${E.R2_BUCKET}`);
    } catch (e) {
      R.fail("bucket", `${e.message} - it isn't empty: saved state (configs_sync/) may be in it. Empty it by hand in the dashboard if you really mean to, then rerun`);
    }
  },
};
