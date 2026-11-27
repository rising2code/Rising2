// Small helpers shared by the modules.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Public text (status log, Discord) shows IPv4 addresses as "203.0.x.x": the server's address is
// public through DNS anyway, but there's no need to hand it to every crawler of /api/status.
export const maskIps = (s) => String(s).replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.$2.x.x");

export const hex =(buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
