// The site's links and the public resource archive, both read from R2 (Deploy steps 05a / 05b upload them;
// edit them in R2 any time): site/urls.json {discord, github, download, ...} and
// site/s3files.json {files: [{key, name, size?, about?}]}. Archive files sit in an S3 bucket (OVH
// Object Storage) that isn't public: /sign-s3-1 hands out a 10-minute download link for one listed file.
import { json } from "./util.js";

const URLS_KEY = "site/urls.json";
const FILES_KEY = "site/s3files.json";
const LINK_SECONDS = 600;

async function r2Json(env, key, empty) {
  const obj = await env.R2.get(key);
  if (!obj) return empty;
  try { return JSON.parse(await obj.text()); } catch { return empty; }
}

// GET /links
export const getLinks = async (env) => json(await r2Json(env, URLS_KEY, {}));

// GET /get-files: the list, without anything but what the page shows
export async function getFiles(env) {
  const list = (await r2Json(env, FILES_KEY, { files: [] })).files || [];
  return json({ files: list.filter((f) => f && f.key).map(({ key, name, size, about }) => ({ key, name: name || key, size, about })) });
}

// POST /sign-s3-1 {key}: only keys listed in s3files.json can be signed
export async function signFile(req, env) {
  const { key } = await req.json().catch(() => ({}));
  const list = (await r2Json(env, FILES_KEY, { files: [] })).files || [];
  if (!key || !list.some((f) => f && f.key === key)) return json({ error: "unknown file" }, 404);
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return json({ error: "archive not set up" }, 503);
  return json({ url: await presignGet(env, key, LINK_SECONDS), expiresIn: LINK_SECONDS });
}

// ---- S3 presigned GET (AWS Signature V4, query string), path-style: <endpoint>/<bucket>/<key>
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function hmac(key, s) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s));
}

export async function presignGet(env, key, seconds) {
  const base = new URL(env.S3_ENDPOINT);
  const region = env.S3_REGION || "us-east-1";
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, ""); // 20261127T030405Z
  const day = now.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const path = `${base.pathname.replace(/\/$/, "")}/${enc(env.S3_BUCKET)}/${key.split("/").map(enc).join("/")}`;
  const q = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${env.S3_ACCESS_KEY}/${scope}`,
    "X-Amz-Date": now,
    "X-Amz-Expires": String(seconds),
    "X-Amz-SignedHeaders": "host",
  };
  const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonical = ["GET", path, query, `host:${base.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", now, scope, await sha256(canonical)].join("\n");
  let k = await hmac(`AWS4${env.S3_SECRET_KEY}`, day);
  for (const part of [region, "s3", "aws4_request"]) k = await hmac(k, part);
  return `${base.origin}${path}?${query}&X-Amz-Signature=${toHex(await hmac(k, toSign))}`;
}
