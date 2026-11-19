// OVH Public Cloud API: signed requests, the game VM, and this month's cost.
import CLOUD_INIT from "../../LazyServer/cloud_init.sh";
import { hex } from "./util.js";

const project = (env) => `/cloud/project/${env.OVH_PROJECT}`;

// Every instance in the project, all regions (no ?region= filter).
export async function listInstances(env) {
  return ovh(env, "GET", `${project(env)}/instance`);
}

// Our game VM (by name), for teardown.
export async function findInstance(env) {
  return (await listInstances(env)).find((i) => i.name === env.VM_NAME) || null;
}

export async function deleteInstance(env, id) {
  return ovh(env, "DELETE", `${project(env)}/instance/${id}`);
}

// Create the VM with cloud_init.sh as its userData; tries OVH_FLAVORS in order (one may be
// out of stock). onCreated / onFlavorFailed get a status line.
export async function createInstance(env, onCreated, onFlavorFailed) {
  const region = env.OVH_REGION;
  const [flavors, images] = await Promise.all([
    ovh(env, "GET", `${project(env)}/flavor?region=${region}`),
    ovh(env, "GET", `${project(env)}/image?region=${region}&osType=linux`),
  ]);
  const image = images.find((i) => i.name === env.OVH_IMAGE);
  if (!image) throw new Error(`image ${env.OVH_IMAGE} not found in ${region}`);

  const userData = CLOUD_INIT
    .replaceAll("__WORKER_URL__", `${env.PUBLIC_URL}/api`)
    .replaceAll("__TOKEN__", env.SHARED_TOKEN)
    .replaceAll("__GAME_ZIP_URL__", env.GAME_ZIP_URL);

  let lastErr;
  for (const name of env.OVH_FLAVORS.split(",").map((s) => s.trim())) {
    const flavor = flavors.find((f) => f.name === name);
    if (!flavor) continue;
    try {
      await ovh(env, "POST", `${project(env)}/instance`, {
        name: env.VM_NAME, region, flavorId: flavor.id, imageId: image.id, userData, monthlyBilling: false,
      });
      await onCreated(`VM created (${name}), booting...`);
      return;
    } catch (e) {
      lastErr = e;
      await onFlavorFailed(`Flavor ${name} failed: ${e.message.slice(0, 120)}`);
    }
  }
  throw lastErr || new Error("no flavor available");
}

// This month's bill for the whole project: VMs, Object Storage (the Game.zip bucket), traffic,
// volumes... OVH adds usage up hourly, so the last hour or two may not be in yet.
export async function monthCost(env) {
  const base = `${project(env)}/usage`;
  const [cur, fc] = await Promise.all([ovh(env, "GET", `${base}/current`), ovh(env, "GET", `${base}/forecast`)]);
  return { current: sumPrices(cur), forecast: sumPrices(fc) };
}

// Adds up every "totalPrice" in OVH's usage tree. Once an item has a totalPrice its children
// (per-instance details, stored/bandwidth parts) are already in it, so we don't go deeper.
function sumPrices(node) {
  if (Array.isArray(node)) return node.reduce((a, n) => a + sumPrices(n), 0);
  if (!node || typeof node !== "object") return 0;
  if (typeof node.totalPrice === "number") return node.totalPrice;
  if (node.totalPrice && typeof node.totalPrice.value === "number") return node.totalPrice.value;
  return Object.values(node).reduce((a, n) => a + sumPrices(n), 0);
}

export const fmtCost = (c) => `€${c.current.toFixed(2)} (forecast for the month €${c.forecast.toFixed(2)})`;

// A signed OVH API call: X-Ovh-Signature = "$1$" + SHA1(secret+consumerKey+method+url+body+timestamp).
async function ovh(env, method, path, body) {
  const url = env.OVH_ENDPOINT + path;
  const data = body ? JSON.stringify(body) : "";
  const now = Math.floor(Date.now() / 1000);
  const toSign = [env.OVH_APP_SECRET, env.OVH_CONSUMER_KEY, method, url, data, now].join("+");
  const sig = "$1$" + hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(toSign)));
  const r = await fetch(url, {
    method, body: data || undefined,
    headers: {
      "content-type": "application/json",
      "X-Ovh-Application": env.OVH_APP_KEY,
      "X-Ovh-Consumer": env.OVH_CONSUMER_KEY,
      "X-Ovh-Timestamp": String(now),
      "X-Ovh-Signature": sig,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OVH ${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
