// One real loop: start a VM through the worker, wait for "up", check DNS, stop it, wait until it's deleted.
import { F, ovhApi, waitFor, sleep, checkOvhKey } from "../../lib.mjs";
import { S, ovhCreds } from "../../specs.mjs";

export default {
  title: "Test: start a real VM through the worker, then stop it (a few minutes of VM time)",
  manual: ["every step before this one done", "the VM's files in R2 (05) and Game.zip at GAME_ZIP_URL"],
  waitMin: 25,
  env: [
    S.DOMAIN,
    { name: "API_URL", f: F.url, about: "the worker's base URL (default https://<domain>/api)" },
    S.SHARED_TOKEN,
    // OVH: to confirm the VM is really gone, and to delete it if it didn't go by itself
    S.OVH_ENDPOINT,
    { name: "OVH_APP_KEY", f: F.ovhAppKey, required: true, about: "an OVH key that can list + delete the project's VMs: Application Key" },
    { name: "OVH_APP_SECRET", f: F.ovhSecret, required: true, about: "that key's Application Secret" },
    { name: "OVH_CONSUMER_KEY", f: F.ovhConsumer, required: true, about: "that key's Consumer Key" },
    S.OVH_PROJECT, S.VM_NAME,
    { name: "POLL_SEC", f: F.number, def: "15", about: "how often to check (seconds)" },
  ],

  async deploy(E, R) {
    const api = E.API_URL || `https://${E.DOMAIN}/api`;
    const H = { authorization: `Bearer ${E.SHARED_TOKEN}` };
    const call = async (m, p) => { const r = await fetch(`${api}${p}`, { method: m, headers: H }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const ovh = ovhApi(ovhCreds(E));
    await checkOvhKey(ovh, R, E.OVH_ENDPOINT, [["GET", `/cloud/project/${E.OVH_PROJECT}/instance`], ["DELETE", `/cloud/project/${E.OVH_PROJECT}/instance/x`]]);
    const vmsNamed = async () => (await ovh("GET", `/cloud/project/${E.OVH_PROJECT}/instance`)).filter((v) => v.name === E.VM_NAME);
    const t0 = Date.now(), mins = () => ((Date.now() - t0) / 60e3).toFixed(1);
    let seen = Math.max(0, ...((await call("GET", "/status")).body.log || []).map((l) => l.t));
    const follow = async () => {
      const st = (await call("GET", "/status")).body;
      for (const l of (st.log || []).filter((l) => l.t > seen)) { console.log(`     [${mins()} min] ${l.msg}`); seen = l.t; }
      return st;
    };

    const start = await call("POST", "/admin/start");
    if (start.status !== 200) return R.fail("start", `${start.status} ${start.body.message || start.body.error || ""}`);
    R.ok("start", "the worker accepted it");

    let st;
    try {
      st = await waitFor("the VM to report up", async () => { st = await follow(); return ["up", "off", "error"].includes(st.state) ? st : null; },
        { minutes: E.WAIT_MIN, everySec: Number(E.POLL_SEC) });
    } catch (e) { R.fail("up", `${e.message} (state "${st?.state}")`); }
    if (st?.state === "up") {
      R.ok("up", `after ${mins()} min`);
      const dns = await fetch(`https://cloudflare-dns.com/dns-query?name=ip.${E.DOMAIN}&type=A`, { headers: { accept: "application/dns-json" } }).then((r) => r.json()).catch(() => null);
      const ip = dns?.Answer?.[0]?.data;
      ip && ip !== "127.0.0.1" ? R.ok("DNS", `ip.${E.DOMAIN} -> ${ip}`) : R.warn("DNS", `ip.${E.DOMAIN} -> ${ip || "?"} (may still be cached; TTL 60 s)`);
    } else if (st) R.fail("up", `state "${st.state}" after ${mins()} min - see the log lines above`);

    await this.undeploy(E, R, { call, follow, vmsNamed, mins });
  },

  // Graceful stop through the worker; if the VM doesn't go in 10 min, delete it straight through OVH
  // so it can't keep billing. Also the clean-up after a failed or interrupted test.
  async undeploy(E, R, h) {
    const api = E.API_URL || `https://${E.DOMAIN}/api`;
    const H = { authorization: `Bearer ${E.SHARED_TOKEN}` };
    const ovh = ovhApi(ovhCreds(E));
    const vmsNamed = h?.vmsNamed || (async () => (await ovh("GET", `/cloud/project/${E.OVH_PROJECT}/instance`)).filter((v) => v.name === E.VM_NAME));
    const follow = h?.follow || (async () => fetch(`${api}/status`).then((r) => r.json()).catch(() => ({})));
    if (!(await vmsNamed()).length) {
      const st = await follow();
      if (st.state !== "starting" && st.state !== "stopping") return R.ok("stop", `no ${E.VM_NAME} running`);
    }
    const r = await fetch(`${api}/admin/stop`, { method: "POST", headers: H }).catch((e) => ({ status: e.message }));
    R.info("stop", `stop requested (${r.status}), waiting for the VM to sync and delete itself...`);
    try {
      await waitFor("the VM to be deleted", async () => { const st = await follow(); return st.state === "off" && !(await vmsNamed()).length; },
        { minutes: 10, everySec: Number(E.POLL_SEC) || 15 });
      R.ok("teardown", `VM gone, state off${h?.mins ? ` (${h.mins()} min in total)` : ""}`);
    } catch {
      for (const v of await vmsNamed()) await ovh("DELETE", `/cloud/project/${E.OVH_PROJECT}/instance/${v.id}`);
      R.fail("teardown", "the VM did not delete itself in 10 min - deleted it through the OVH API; check the VM's log (journalctl -u rising2-tick)");
    }
  },
};
