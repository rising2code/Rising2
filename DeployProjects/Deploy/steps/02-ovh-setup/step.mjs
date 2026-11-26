// OVH project setup: the VM's region enabled, its flavors + image available, the cost API readable.
import { F, ovhApi, waitFor, sumPrices } from "../../lib.mjs";
import { S, ovhKey, ovhCreds } from "../../specs.mjs";

export default {
  title: "OVH: enable the region(s), check flavors / image / cost API",
  manual: ["the Public Cloud project created in the OVH panel (Public Cloud > Create a project); its id goes in OVH_PROJECT",
    "an OVH key with GET/POST/DELETE /cloud/project/* (POST enables a region)"],
  waitMin: 10,
  env: [
    ...ovhKey("deploy"),
    S.OVH_PROJECT, S.OVH_REGION,
    { name: "OVH_FLAVORS", f: F.flavors, required: true, def: "c3-8,b3-16", about: "VM sizes the worker tries, in order" },
    S.OVH_IMAGE,
    S.VM_NAME,
  ],

  async deploy(E, R) {
    const ovh = ovhApi(ovhCreds(E));
    const P = `/cloud/project/${E.OVH_PROJECT}`;
    const regions = E.OVH_REGION.split(",").map((s) => s.trim()).filter(Boolean);
    const names = E.OVH_FLAVORS.split(",").map((s) => s.trim());
    let usable = 0;
    for (const region of regions) {
      try {
        if ((await ovh("GET", `${P}/region`)).includes(region)) R.ok(`${region}: region`, "enabled");
        else {
          R.info(`${region}: region`, "enabling...");
          await ovh("POST", `${P}/region`, { region });
          await waitFor(`region ${region}`, async () => (await ovh("GET", `${P}/region`)).includes(region), { minutes: E.WAIT_MIN });
          R.ok(`${region}: region`, "enabled");
        }
        // a region that was just enabled can list its flavors / images only after a while
        const found = await waitFor(`flavors in ${region}`, async () => {
          const fl = await ovh("GET", `${P}/flavor?region=${region}`);
          const f = names.filter((n) => fl.some((x) => x.name === n));
          return f.length ? f : null;
        }, { minutes: E.WAIT_MIN });
        R.ok(`${region}: flavors`, `${found.join(", ")} available${found.length < names.length ? ` (not: ${names.filter((n) => !found.includes(n)).join(", ")})` : ""}`);
        const wanted = E.OVH_IMAGE.split(",").map((s) => s.trim()).filter(Boolean);
        const img = await waitFor(`image ${wanted.join(" / ")} in ${region}`, async () => {
          const names = (await ovh("GET", `${P}/image?region=${region}&osType=linux`)).map((i) => i.name);
          return wanted.find((w) => names.includes(w)) || null;
        }, { minutes: E.WAIT_MIN });
        if (img === wanted[0]) R.ok(`${region}: image`, `"${img}" available`);
        else R.warn(`${region}: image`, `"${wanted[0]}" not offered here: the VM will use "${img}"`);
        usable++;
      } catch (e) {
        // one region failing is a warning while another one works: the worker skips it
        (regions.length > 1 ? R.warn : R.fail)(`${region}`, `${e.message}${regions.length > 1 ? " - the worker will skip it and try the next region" : ""}`);
      }
    }
    if (regions.length > 1) (usable ? R.ok : R.fail)("regions", `${usable} of ${regions.length} usable, tried in order: ${regions.join(" -> ")}`);

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
    R.info("regions", `${E.OVH_REGION} left enabled (free)`);
  },
};
