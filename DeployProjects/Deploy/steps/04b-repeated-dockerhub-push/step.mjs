// Docker Hub: builds the game server images from this repo and pushes them (:latest, plus the commit).
// Run it after changing GameSpy_UnifiedServer / ServerLauncher; the VM pulls :latest at its next start.
import fs from "node:fs";
import path from "node:path";
import { REPO, docker, dockerLogin } from "../../lib.mjs";
import { S, IMAGES } from "../../specs.mjs";

export default {
  title: "Docker Hub: build the game server images and push them",
  manual: ["04a-dockerhub-repos done (the repos exist)", "Docker Desktop running"],
  needsDocker: true,
  waitMin: 30,
  env: [S.DOCKERHUB_USER, S.DOCKERHUB_TOKEN],

  async deploy(E, R) {
    const ref = dockerLogin(E, R);
    // step.ps1 / step.sh pass the commit; "+dirty" = uncommitted changes, so no commit tag for it
    const commit = process.env.GIT_COMMIT || "";
    const clean = /^[0-9a-f]{7,40}$/.test(commit);
    if (!clean) R.warn("commit", commit ? `${commit}: uncommitted changes - pushed as :latest only` : "unknown (no git): pushed as :latest only");

    for (const img of IMAGES) {
      const dockerfile = path.join(REPO, img.dockerfile);
      if (!fs.existsSync(dockerfile)) { R.info(img.name, `skipped: no ${img.dockerfile} yet`); continue; }
      const tags = [`${ref(img.name)}:latest`, ...(clean ? [`${ref(img.name)}:${commit}`] : [])];
      const t0 = Date.now();
      docker(["build", "--pull", "-f", dockerfile, ...tags.flatMap((t) => ["-t", t]),
        "--label", `org.opencontainers.image.revision=${commit || "unknown"}`, path.join(REPO, img.dir)], { live: true });
      for (const t of tags) docker(["push", t], { live: true });
      R.ok(img.name, `pushed ${tags.map((t) => t.split(":").pop()).join(" + ")} in ${Math.round((Date.now() - t0) / 1000)} s`);
      R.output(img.env, tags[0]);
    }
    R.info("next", "the VM pulls :latest at its next start; server.env (05b) can name these images (IMG_* above)");
  },

  async undeploy(E, R) {
    R.info("images", "nothing to undo: pushed images stay on Docker Hub (delete tags at hub.docker.com > the repo > Tags)");
  },
};
