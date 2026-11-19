// Small helpers shared by the modules.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
