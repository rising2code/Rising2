// Docker Hub: makes the three image repos by pushing a tiny placeholder image to each (:placeholder).
// A push creates the repo, so no extra permission is needed. Safe to repeat.
import path from "node:path";
import { SRC, docker, dockerLogin } from "../../lib.mjs";
import { S, IMAGES } from "../../specs.mjs";

export default {
  title: "Docker Hub: the image repos (<user>/rising2-...), each with a placeholder image",
  manual: ["a Docker Hub account and a personal access token with Read & Write",
    "Docker Desktop running (step.ps1 lets this step use it)"],
  needsDocker: true,
  waitMin: 5,
  env: [S.DOCKERHUB_USER, S.DOCKERHUB_TOKEN],

  async deploy(E, R) {
    const ref = dockerLogin(E, R);
    const local = "rising2-placeholder:build";
    docker(["build", "-q", "-t", local, path.join(SRC, "Deploy", "placeholder")]);
    R.ok("placeholder", "built (one text file, runs nothing)");
    for (const img of IMAGES) {
      const tag = `${ref(img.name)}:placeholder`;
      docker(["tag", local, tag]);
      docker(["push", "-q", tag]);
      R.ok(img.name, `${tag} pushed - the repo exists (${img.about})`);
    }
    R.info("visibility", "a repo made by a push gets your Docker Hub default (public unless you changed it); "
      + "change it at hub.docker.com > the repo > Settings");
  },

  // Deleting a Docker Hub repo deletes every image in it: not done by a script.
  async undeploy(E, R) {
    R.info("repos", `not deleted here (they hold your images). To remove one: hub.docker.com > ${E.DOCKERHUB_USER}/<name> > Settings > Delete`);
  },
};
