// OVH Public Cloud project: find it by name, or order it (OVH_CREATE_PROJECT=yes) and wait until it's ready.
import { F, ovhApi, waitFor } from "../../lib.mjs";
import { S, ovhKey, ovhCreds } from "../../specs.mjs";

export default {
  title: "OVH: find (or order) the Public Cloud project",
  manual: [
    "OVH account with a payment method (only needed to order a project)",
    "an API key at https://eu.api.ovh.com/createToken/ with rights: GET /auth/currentCredential, GET /cloud/project, GET/POST/DELETE /cloud/project/* (+ GET/POST /order/* to order a project)",
  ],
  waitMin: 15,
  env: [
    ...ovhKey("deploy"),
    { name: "OVH_PROJECT_NAME", f: F.any, required: true, def: "rising2", about: "the project's name (its description in OVH)" },
    { name: "OVH_CREATE_PROJECT", f: F.yesno, required: true, def: "no", about: "yes = order the project if it's missing (the project is free; you pay for what runs in it)" },
    { name: "OVH_SUBSIDIARY", f: F.any, def: "FR", about: "your OVH account's country code, for the order (FR, GB, DE, CA, ...)" },
  ],

  async deploy(E, R) {
    const ovh = ovhApi(ovhCreds(E));
    const cred = await ovh("GET", "/auth/currentCredential");
    R.ok("OVH key", `valid (${cred.status}), ${cred.rules?.length ?? "?"} rules`);
    const rules = (cred.rules || []).map((r) => `${r.method} ${r.path}`);
    for (const need of ["GET /cloud/project", "GET /cloud/project/*"]) {
      if (!rules.includes(need) && !rules.some((r) => r.endsWith(" /*"))) R.warn("OVH key rules", `no "${need}" rule - add it to the key`);
    }

    let id = await findProject(ovh, E.OVH_PROJECT_NAME);
    if (!id) {
      if (E.OVH_CREATE_PROJECT !== "yes") {
        R.fail("project", `no project named "${E.OVH_PROJECT_NAME}": create it in the panel (Public Cloud > Create a project), or set OVH_CREATE_PROJECT=yes`);
        return;
      }
      R.info("project", `ordering "${E.OVH_PROJECT_NAME}"...`);
      const cart = await ovh("POST", "/order/cart", { ovhSubsidiary: E.OVH_SUBSIDIARY, description: E.OVH_PROJECT_NAME });
      await ovh("POST", `/order/cart/${cart.cartId}/assign`);
      const item = await ovh("POST", `/order/cart/${cart.cartId}/cloud`, { duration: "P1M", planCode: "project.2018", pricingMode: "default", quantity: 1 });
      await ovh("POST", `/order/cart/${cart.cartId}/item/${item.itemId}/configuration`, { label: "description", value: E.OVH_PROJECT_NAME });
      const order = await ovh("POST", `/order/cart/${cart.cartId}/checkout`, { autoPayWithPreferredPaymentMethod: true, waiveRetractationPeriod: true });
      R.ok("order", `order ${order.orderId} placed (${order.url || "see My orders in the panel"})`);
      id = await waitFor("the new project to show up", () => findProject(ovh, E.OVH_PROJECT_NAME), { minutes: E.WAIT_MIN, everySec: 20 });
    }
    const p = await waitFor(`project ${id} to be ready`, async () => {
      const p = await ovh("GET", `/cloud/project/${id}`);
      return p.status === "ok" ? p : null;
    }, { minutes: E.WAIT_MIN, everySec: 20 });
    R.ok("project", `"${p.description}" = ${id} (status ${p.status})`);
    R.output("OVH_PROJECT", id);
  },

  // Deletes the VMs in the project (they cost money). The project itself is left: deleting it
  // is an account action OVH confirms by email - do it in the panel if you really want it gone.
  async undeploy(E, R) {
    const ovh = ovhApi(ovhCreds(E));
    const id = await findProject(ovh, E.OVH_PROJECT_NAME);
    if (!id) return R.ok("project", `no project named "${E.OVH_PROJECT_NAME}" - nothing to clean`);
    const vms = await ovh("GET", `/cloud/project/${id}/instance`);
    for (const v of vms) await ovh("DELETE", `/cloud/project/${id}/instance/${v.id}`);
    if (vms.length) {
      await waitFor("the VMs to be deleted", async () => !(await ovh("GET", `/cloud/project/${id}/instance`)).length, { minutes: E.WAIT_MIN });
      R.ok("VMs", `deleted ${vms.map((v) => v.name).join(", ")}`);
    } else R.ok("VMs", "none");
    R.todo("project", `left in place (${id}). To delete it: OVH panel > Public Cloud > ${E.OVH_PROJECT_NAME} > Settings > Delete project`);
  },
};

async function findProject(ovh, name) {
  for (const id of await ovh("GET", "/cloud/project")) {
    const p = await ovh("GET", `/cloud/project/${id}`);
    if (p.description === name) return id;
  }
  return null;
}
