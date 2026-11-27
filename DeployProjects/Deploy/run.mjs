// Runs one deploy step:  run.mjs <step> deploy|undeploy|check
//   deploy    create / update what the step owns (safe to repeat: it checks first)
//   undeploy  remove what the step created, so a failed deploy can start clean
//   check     only validate step.env (nothing is called)
// Also:       run.mjs list          the steps in order
//             run.mjs <step> example   print the step's step.env.example
//             run.mjs token         a new 64-hex shared token
// The step's settings come from its own env file (docker --env-file steps/<step>/step.env).
// Results: /out/<step>/<action>.report.md (+ .json), and outputs.env for values later steps need.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnv, exampleEnv, makeReport, DRY } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS = path.join(HERE, "steps");
const OUT = process.env.OUT_DIR || "/out";
const [stepArg, action = "deploy"] = process.argv.slice(2);

const ids = fs.readdirSync(STEPS).filter((d) => fs.existsSync(path.join(STEPS, d, "step.mjs"))).sort();
if (!stepArg || stepArg === "list") {
  console.log("Steps, in order (each: deploy | undeploy | check):\n");
  const w = Math.max(...ids.map((d) => d.length)) + 2;
  for (const id of ids) console.log(`  ${id.padEnd(w)} ${(await import(`./steps/${id}/step.mjs`)).default.title}`);
  process.exit(0);
}
if (stepArg === "token") { console.log(randomBytes(32).toString("hex")); process.exit(0); }

// exact name, name without its number, or else a prefix that matches only one step ("06", "05a")
// ("repeated-" marks the steps run again and again; it can be left out too: "cloudflare-pages")
const bare = (d) => d.replace(/^\d+[a-z]?-(repeated-)?/, "");
let id = ids.find((d) => d === stepArg || bare(d) === stepArg);
if (!id) {
  const hits = ids.filter((d) => d.startsWith(stepArg) || bare(d).startsWith(stepArg));
  if (hits.length > 1) { console.error(`"${stepArg}" matches more than one step: ${hits.join(", ")}`); process.exit(2); }
  id = hits[0];
}
if (!id) { console.error(`unknown step "${stepArg}" - one of: ${ids.join(", ")}`); process.exit(2); }
const step = (await import(`./steps/${id}/step.mjs`)).default;
step.id = id;

if (action === "example") { process.stdout.write(exampleEnv(step)); process.exit(0); }
if (!["deploy", "undeploy", "check"].includes(action)) { console.error("action: deploy | undeploy | check | example"); process.exit(2); }

console.log(`${id} - ${action}${DRY ? " (DRY RUN: wrangler commands are only printed)" : ""}\n${step.title}\n`);
const R = makeReport(path.join(OUT, id), id, action);
const { E, problems } = loadEnv(step.env);
E.WAIT_MIN ||= step.waitMin ?? 10;

for (const p of problems) {
  if (p.kind === "missing") R.fail(`setting ${p.name}`, `missing - ${p.about}. Looks like: ${p.shape}`);
  else R.warn(`setting ${p.name}`, `doesn't look like ${p.shape} - check it`);
}
const missing = problems.filter((p) => p.kind === "missing");
if (!missing.length) R.ok("settings", `${step.env.length} checked${problems.length ? ", see the warnings" : ""}`);

if (action !== "check" && !missing.length) {
  try {
    await step[action](E, R);
  } catch (e) {
    R.fail(`${action} stopped`, e.message);
  }
}
if (missing.length && action !== "check") R.info(action, "not run: fill in the missing settings first");

R.write();
const failed = R.failed();
console.log(`\n${failed ? "❌ failed" : "✅ done"} - report: ${path.join(OUT, id, `${action}.report.md`)}`);
if (failed && action === "deploy" && step.undeploy) console.log(`   to start clean: run ${id} undeploy, fix the cause, then deploy again`);
process.exit(failed ? 1 : 0);
