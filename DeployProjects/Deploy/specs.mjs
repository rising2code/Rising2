// Setting definitions reused by several steps (definitions only - each step still reads its own step.env).
import { F } from "./lib.mjs";

export const S = {
  DOMAIN: { name: "DOMAIN", f: F.domain, required: true, about: "the site's domain, a zone in your Cloudflare account" },
  CF_API_TOKEN: (perms) => ({ name: "CF_API_TOKEN", f: F.cfToken, required: true, about: `Cloudflare API token with: ${perms}` }),
  CF_ACCOUNT_ID: { name: "CF_ACCOUNT_ID", f: F.hex32, required: true, about: "Cloudflare account id (03-cloudflare-dns prints it; also dashboard > Account Home > Account ID)" },
  OVH_ENDPOINT: { name: "OVH_ENDPOINT", f: F.ovhEndpoint, required: true, def: "https://eu.api.ovh.com/1.0", about: "the OVH API site the keys were made on" },
  OVH_APP_KEY: (which) => ({ name: "OVH_APP_KEY", f: F.ovhAppKey, required: true, about: `OVH ${which} key: Application Key` }),
  OVH_APP_SECRET: (which) => ({ name: "OVH_APP_SECRET", f: F.ovhSecret, required: true, about: `OVH ${which} key: Application Secret` }),
  OVH_CONSUMER_KEY: (which) => ({ name: "OVH_CONSUMER_KEY", f: F.ovhConsumer, required: true, about: `OVH ${which} key: Consumer Key` }),
  OVH_PROJECT: { name: "OVH_PROJECT", f: F.ovhProject, required: true, about: "the OVH Public Cloud project id, created by hand in the OVH panel" },
  OVH_REGION: { name: "OVH_REGION", f: F.ovhRegion, required: true, def: "DE1,GRA11", about: "OVH region(s) the VM may run in, first choice first (the next is tried if one is full)" },
  OVH_IMAGE: { name: "OVH_IMAGE", f: F.any, required: true, def: "Debian 12 - Docker,Debian 12", about: "the VM's OS image(s), first one found in the region is used (exact OVH names)" },
  VM_NAME: { name: "VM_NAME", f: F.name, required: true, def: "rising2-lazy", about: "the game VM's name (the worker creates and deletes only this name)" },
  R2_BUCKET: { name: "R2_BUCKET", f: F.name, required: true, def: "rising2", about: "R2 bucket name" },
  SHARED_TOKEN: { name: "SHARED_TOKEN", f: F.sharedToken, required: true, about: "token between the worker and the VM / the test loop" },
  DOCKERHUB_USER: { name: "DOCKERHUB_USER", f: F.dockerId, required: true, about: "your Docker Hub user: the images are <user>/rising2-..." },
  DOCKERHUB_TOKEN: { name: "DOCKERHUB_TOKEN", f: F.dockerToken, required: true, about: "a Docker Hub personal access token with Read & Write (the one that works with docker login)" },
};

// The game server images on Docker Hub (<user>/<name>). dir / dockerfile are relative to the repo
// root; an image whose Dockerfile isn't there yet is skipped by 04b (04a still makes its repo).
// env: the server.env setting that names it for the VM's docker-compose.yml.
export const IMAGES = [
  { name: "rising2-gamespy-mock-server", dir: "GameSpy_UnifiedServer", dockerfile: "GameSpy_UnifiedServer/Dockerfile", env: "IMG_GAMESPY",
    about: "the GameSpy mock: login, server list, stats" },
  { name: "rising2-re-dedicated-server", dir: "ServerLauncher", dockerfile: "ServerLauncher/docker/Dockerfile", env: "IMG_DEDICATED",
    about: "the Rising Eagle dedicated server under Wine" },
  { name: "rising2-server-dl-manager", dir: "ServerDlManager", dockerfile: "ServerDlManager/Dockerfile", env: "IMG_DL_MANAGER",
    about: "downloads Game.zip once into the shared folder the game servers mount" },
];

export const ovhKey = (which) => [S.OVH_ENDPOINT, S.OVH_APP_KEY(which), S.OVH_APP_SECRET(which), S.OVH_CONSUMER_KEY(which)];
export const ovhCreds = (E) => ({ endpoint: E.OVH_ENDPOINT, appKey: E.OVH_APP_KEY, appSecret: E.OVH_APP_SECRET, consumerKey: E.OVH_CONSUMER_KEY });
