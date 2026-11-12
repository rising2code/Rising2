// Game-specific level files, decoded from the Eiffel level and RisingEagle.exe:
//   heightmap.bmp   24-bit BMP; height = minHeight + B + G/100 + R/10000
//   lightmap.mdat   "TADM" + per-object lightmap UVs keyed by CRC32("/usr/level/" + node path)
//   <level>.dat     UTF-16 "[Key]value#" text written through a C text-mode stream
//   .setcrc         CRC16 of terrainmesh.nvx2 as read in C text mode

// ---------- BMP / heightmap ----------

export function readBmp24(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP file');
  const off = dv.getUint32(10, true);
  const w = dv.getInt32(18, true);
  const h = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  if (bpp !== 24) throw new Error(`expected a 24-bit BMP, got ${bpp}-bit`);
  const rowSize = (w * 3 + 3) & ~3;
  return { width: w, height: Math.abs(h), rowSize, off, bytes };
}

/** Heights in file row order: heights[row * width + col]; row r is world z = r * spacing. */
export function decodeHeightmap(bytes, minHeight) {
  const b = readBmp24(bytes);
  const heights = new Float32Array(b.width * b.height);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const o = b.off + y * b.rowSize + x * 3;
      heights[y * b.width + x] = minHeight + bytes[o] + bytes[o + 1] / 100 + bytes[o + 2] / 10000;
    }
  }
  return { width: b.width, height: b.height, heights };
}

/** Inverse of decodeHeightmap. Returns {bytes, minHeight, maxHeight}. */
export function encodeHeightmap(heights, width, height) {
  let min = Infinity, max = -Infinity;
  for (const v of heights) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min >= 255.99) throw new Error('terrain height range above 255 m cannot be stored in this heightmap format');
  const rowSize = (width * 3 + 3) & ~3;
  const size = 54 + rowSize * height;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = Math.round((heights[y * width + x] - min) * 10000);
      const B = Math.floor(v / 10000); v -= B * 10000;
      const G = Math.floor(v / 100); v -= G * 100;
      const o = 54 + y * rowSize + x * 3;
      out[o] = B; out[o + 1] = G; out[o + 2] = v;
    }
  }
  return { bytes: out, minHeight: min, maxHeight: max };
}

// ---------- checksums ----------

let crc32Table = null;
export function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32Table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crc32Table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32String(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return crc32(b);
}

let crc16Table = null;
/** The game's CRC16: CCITT table (MSB-first, poly 0x1021) used with a right-shifting loop. */
export function crc16Game(bytes) {
  if (!crc16Table) {
    crc16Table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
      crc16Table[i] = c;
    }
  }
  let c = 0xffff;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ crc16Table[(c ^ bytes[i]) & 255];
  return ~c & 0xffff;
}

/** What the game's fopen(..,"r") + getc loop sees: CRLF -> LF, stop at the first 0x1A. */
export function textModeView(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x1a) break;
    if (b === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** Value for the terrain node's ".setcrc" given terrainmesh.nvx2 bytes. */
export function terrainMeshCrc(bytes) {
  return crc16Game(textModeView(bytes));
}

// ---------- lightmap.mdat ----------

export const LIGHTMAP_PREFIX = '/usr/level/';

export function lightmapKey(nodePath) {
  return crc32String(LIGHTMAP_PREFIX + nodePath);
}

/** @returns {Map<number, {atlas: string, uv: Float32Array}>} */
export function parseLightmapMdat(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'TADM') throw new Error('not a lightmap.mdat file');
  const count = dv.getUint16(4, true);
  const records = new Map();
  let p = 6;
  for (let r = 0; r < count; r++) {
    const key = dv.getUint32(p, true);
    const len = dv.getUint16(p + 4, true);
    let atlas = '';
    for (let i = 0; i < len; i++) atlas += String.fromCharCode(bytes[p + 6 + i]);
    p += 6 + len;
    const n = dv.getUint16(p, true);
    p += 2;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) uv[i] = dv.getFloat32(p + i * 4, true);
    p += n * 8;
    records.set(key, { atlas, uv });
  }
  if (p !== bytes.length) throw new Error(`lightmap.mdat: ${bytes.length - p} unexpected trailing bytes`);
  return records;
}

export function writeLightmapMdat(records) {
  const keys = [...records.keys()].sort((a, b) => a - b); // the game binary-searches the keys
  if (keys.length > 0xffff) throw new Error('too many lightmap records');
  let size = 6;
  for (const k of keys) { const r = records.get(k); size += 6 + r.atlas.length + 2 + r.uv.length * 4; }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0x54, 0x41, 0x44, 0x4d]);
  dv.setUint16(4, keys.length, true);
  let p = 6;
  for (const k of keys) {
    const r = records.get(k);
    dv.setUint32(p, k, true);
    dv.setUint16(p + 4, r.atlas.length, true);
    for (let i = 0; i < r.atlas.length; i++) out[p + 6 + i] = r.atlas.charCodeAt(i);
    p += 6 + r.atlas.length;
    dv.setUint16(p, r.uv.length / 2, true);
    p += 2;
    for (let i = 0; i < r.uv.length; i++) dv.setFloat32(p + i * 4, r.uv[i], true);
    p += r.uv.length * 4;
  }
  return out;
}

// ---------- <level>.dat (UTF-16 info text) ----------

/** Undoes the C text-mode "\n" -> "\r\n" byte expansion, then decodes UTF-16LE. */
export function decodeLevelDat(bytes) {
  const raw = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    raw.push(bytes[i]);
  }
  const u = new Uint8Array(raw);
  let start = 0;
  if (u[0] === 0xff && u[1] === 0xfe) start = 2;
  return new TextDecoder('utf-16le').decode(u.subarray(start));
}

export function encodeLevelDat(text) {
  const out = [0xff, 0xfe];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) out.push(0x0d, 0x0a, 0x00);
    else out.push(c & 255, c >> 8);
  }
  return new Uint8Array(out);
}

/** "[Key]value#" entries in order (keys repeat for each mission). */
export function parseLevelDatEntries(text) {
  const entries = [];
  const re = /\[([^\]]+)\]([^#]*)#/g;
  let m;
  while ((m = re.exec(text))) entries.push({ key: m[1], value: m[2], start: m.index, end: re.lastIndex });
  return entries;
}
