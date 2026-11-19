// OVH project setup: the VM's region enabled, its flavors + image available, the cost API readable.
import { F, ovhApi, waitFor, sumPrices } from "../../lib.mjs";
import { S, ovhKey, ovhCreds } from "../../specs.mjs";

export default {
  title: "OVH: enable the region, check flavors / image / cost API",
  manual: ["run 01-ovh-project first (it prints OVH_PROJECT)"],
  waitMin: 10,
  env: [
    ...ovhKey("deploy"),
    S.OVH_PROJECT, S.OVH_REGION,
    { name: "OVH_FLAVORS", f: F.flavors, required: true, def: "c3-8,b3-16", about: "VM sizes the worker tries, in order" },
    { name: "OVH_IMAGE", f: F.any, required: true, def: "Debian 12", about: "the VM's OS image name" },
    S.VM_NAME,
  ],

  async deploy(E, R) {
    const ovh = ovhApi(ovhCreds(E));
    const P = `/cloud/project/${E.OVH_PROJECT}`;
    const regions = await ovh("GET", `${P}/region`);
    if (regions.includes(E.OVH_REGION)) R.ok("region", `${E.OVH_REGION} enabled`);
    else {
      R.info("region", `enabling ${E.OVH_REGION}...`);
      await ovh("POST", `${P}/region`, { region: E.OVH_REGION });
      await waitFor(`region ${E.OVH_REGION}`, async () => (await ovh("GET", `${P}/region`)).includes(E.OVH_REGION), { minutes: E.WAIT_MIN });
      R.ok("region", `${E.OVH_REGION} enabled`);
    }

    // a region that was just enabled can list its flavors / images only after a while
    const names = E.OVH_FLAVORS.split(",").map((s) => s.trim());
    const found = await waitFor(`flavors in ${E.OVH_REGION}`, async () => {
      const fl = await ovh("GET", `${P}/flavor?region=${E.OVH_REGION}`);
      const f = names.filter((n) => fl.some((x) => x.name === n));
      return f.length ? f : null;
    }, { minutes: E.WAIT_MIN });
    R.ok("flavors", `${found.join(", ")} available${found.length < names.length ? ` (not: ${names.filter((n) => !found.includes(n)).join(", ")})` : ""}`);
    await waitFor(`image "${E.OVH_IMAGE}"`, async () => (await ovh("GET", `${P}/image?region=${E.OVH_REGION}&osType=linux`)).some((i) => i.name === E.OVH_IMAGE), { minutes: E.WAIT_MIN });
    R.ok("image", `"${E.OVH_IMAGE}" available`);

    const [cur, fc] = await Promise.all([ovh("GET", `${P}/usage/current`), ovh("GET", `${P}/usage/forecast`)]);
    R.ok("cost API", `this month €${sumPrices(cur).toFixed(2)}, forecast €${sumPrices(fc).toFixed(2)}`);
    const vms = await ovh("GET", `${P}/instance`);
    if (vms.length) R.warn("VMs", `${vms.map((v) => `${v.name} (${v.status})`).join(", ")} - the worker refuses Start while any VM exists`);
    else R.ok("VMs", "none running");
  },

  // Removes leftover game VMs (e.g. after a failed test). The region stays enabled (it costs nothing).
  async undeploy(E, R) {
    const ovh = ovhApi(ovhCreds(E));
    const P = `/cloud/project/${E.OVH_PROJECT}`;
    const vms = (await ovh("GET", `${P}/instance`)).filter((v) => v.name === E.VM_NAME);
    for (const v of vms) await ovh("DELETE", `${P}/instance/${v.id}`);
    if (vms.length) {
      await waitFor(`${E.VM_NAME} to be deleted`, async () => !(await ovh("GET", `${P}/instance`)).some((v) => v.name === E.VM_NAME), { minutes: E.WAIT_MIN });
      R.ok("VMs", `deleted ${vms.length} × ${E.VM_NAME}`);
    } else R.ok("VMs", `no ${E.VM_NAME} running`);
    R.info("region", `${E.OVH_REGION} left enabled (free)`);
  },
};
