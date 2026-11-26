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
  OVH_REGION: { name: "OVH_REGION", f: F.ovhRegion, required: true, def: "GRA11", about: "OVH region(s) the VM may run in, first choice first (the next is tried if one is full)" },
  VM_NAME: { name: "VM_NAME", f: F.name, required: true, def: "rising2-lazy", about: "the game VM's name (the worker creates and deletes only this name)" },
  R2_BUCKET: { name: "R2_BUCKET", f: F.name, required: true, def: "rising2", about: "R2 bucket name" },
  SHARED_TOKEN: { name: "SHARED_TOKEN", f: F.sharedToken, required: true, about: "token between the worker and the VM / the test loop" },
};

export const ovhKey = (which) => [S.OVH_ENDPOINT, S.OVH_APP_KEY(which), S.OVH_APP_SECRET(which), S.OVH_CONSUMER_KEY(which)];
export const ovhCreds = (E) => ({ endpoint: E.OVH_ENDPOINT, appKey: E.OVH_APP_KEY, appSecret: E.OVH_APP_SECRET, consumerKey: E.OVH_CONSUMER_KEY });
