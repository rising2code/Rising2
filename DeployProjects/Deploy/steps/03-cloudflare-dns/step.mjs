// Cloudflare DNS for the game: ip.<domain> (A, grey) that the worker points at the VM, and *.<domain> -> ip.
// (The site's own records, <domain> and www, belong to 07-cloudflare-pages.)
import { F, cfApi, zoneOf } from "../../lib.mjs";
import { S } from "../../specs.mjs";

export default {
  title: "Cloudflare: DNS records for the game (ip.<domain>, *.<domain>)",
  manual: ["the domain added to Cloudflare (its nameservers moved to Cloudflare, zone Active)",
    "an API token with Zone:DNS Edit and Zone:Zone Read on that zone"],
  waitMin: 5,
  env: [
    S.CF_API_TOKEN("Zone > DNS Edit + Zone > Zone Read (this zone)"), S.DOMAIN,
    { name: "DNS_TTL", f: F.number, required: true, def: "60", about: "TTL of ip.<domain> in seconds (60 is the lowest outside Enterprise)" },
  ],

  async deploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const z = await zoneOf(cf, E.DOMAIN);
    R.ok("zone", `${z.name} (${z.status})${z.status !== "active" ? " - not active yet: the nameservers aren't moved, records won't resolve" : ""}`);
    const recs = await cf("GET", `/zones/${z.id}/dns_records?per_page=500`);
    const want = [
      { name: `ip.${E.DOMAIN}`, type: "A", content: "127.0.0.1", proxied: false, ttl: Number(E.DNS_TTL) },
      { name: `*.${E.DOMAIN}`, type: "CNAME", content: `ip.${E.DOMAIN}`, proxied: false, ttl: 1 },
    ];
    for (const w of want) {
      const ex = recs.filter((r) => r.name === w.name);
      if (!ex.length) { await cf("POST", `/zones/${z.id}/dns_records`, w); R.ok(w.name, `created ${w.type} ${w.content} (DNS only)`); continue; }
      const r = ex[0];
      if (r.type !== w.type) { R.fail(w.name, `exists as ${r.type} ${r.content} - delete it in the dashboard (or run undeploy) and rerun`); continue; }
      if (r.proxied) { await cf("PATCH", `/zones/${z.id}/dns_records/${r.id}`, { proxied: false }); R.ok(w.name, "was proxied (orange): switched to DNS only - the game needs the real IP"); continue; }
      R.ok(w.name, `exists: ${r.type} ${r.content} (kept - the worker changes ip.<domain> itself)`);
    }
    R.output("CF_ZONE_ID", z.id);
    R.output("CF_ACCOUNT_ID", z.account.id);
  },

  async undeploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const z = await zoneOf(cf, E.DOMAIN);
    const recs = await cf("GET", `/zones/${z.id}/dns_records?per_page=500`);
    const mine = recs.filter((r) => (r.name === `ip.${E.DOMAIN}` && r.type === "A") || (r.name === `*.${E.DOMAIN}` && r.type === "CNAME" && r.content === `ip.${E.DOMAIN}`));
    for (const r of mine) await cf("DELETE", `/zones/${z.id}/dns_records/${r.id}`);
    R.ok("records", mine.length ? `deleted ${mine.map((r) => `${r.name} ${r.type}`).join(", ")}` : "none to delete");
  },
};
