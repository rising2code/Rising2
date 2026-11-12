// DDS textures (standard DirectX format): decoding to RGBA for previews and the
// minimap, and encoding (DXT1, DXT5 or uncompressed A8R8G8B8, with mipmaps).

const DDSD_MIPMAPCOUNT = 0x20000;

function fourCC(s) {
  return s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
}

export function readDdsHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('not a DDS file');
  const flags = dv.getUint32(8, true);
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const mipCount = flags & DDSD_MIPMAPCOUNT ? Math.max(1, dv.getUint32(28, true)) : 1;
  const pfFlags = dv.getUint32(80, true);
  const fcc = dv.getUint32(84, true);
  const bits = dv.getUint32(88, true);
  const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), dv.getUint32(104, true)];
  const caps2 = dv.getUint32(112, true);
  let format;
  if (pfFlags & 4) {
    format = String.fromCharCode(fcc & 255, (fcc >> 8) & 255, (fcc >> 16) & 255, (fcc >> 24) & 255);
  } else if (bits === 32) format = masks[3] ? 'A8R8G8B8' : 'X8R8G8B8';
  else if (bits === 24) format = 'R8G8B8';
  else if (bits === 16 && (pfFlags & 0x20000)) format = 'A8L8';
  else if (bits === 16) format = masks[0] === 0xf800 ? 'R5G6B5' : 'A1R5G5B5';
  else if (bits === 8 && (pfFlags & 2) && !(pfFlags & 0x20000)) format = 'A8';
  else if (bits === 8) format = 'L8';
  else format = `unknown(${bits}bpp)`;
  return { width, height, mipCount, format, bits, masks, cubemap: !!(caps2 & 0x200), dataOffset: 128 };
}

function rgb565(c) {
  return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0];
}

function decodeColorBlock(bytes, o, out, w, x0, y0, isDxt1) {
  const c0 = bytes[o] | (bytes[o + 1] << 8);
  const c1 = bytes[o + 2] | (bytes[o + 3] << 8);
  const a = rgb565(c0), b = rgb565(c1);
  const pal = [a, b];
  let alpha3 = 255;
  if (!isDxt1 || c0 > c1) {
    pal.push(a.map((v, i) => (2 * v + b[i]) / 3 | 0), a.map((v, i) => (v + 2 * b[i]) / 3 | 0));
  } else {
    pal.push(a.map((v, i) => (v + b[i]) / 2 | 0), [0, 0, 0]);
    alpha3 = 0;
  }
  const bitsv = bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const x = x0 + (i & 3), y = y0 + (i >> 2);
    if (x >= w || y >= out.length / 4 / w) continue;
    const idx = (bitsv >>> (i * 2)) & 3;
    const p = (y * w + x) * 4;
    out[p] = pal[idx][0]; out[p + 1] = pal[idx][1]; out[p + 2] = pal[idx][2];
    out[p + 3] = isDxt1 ? (idx === 3 ? alpha3 : 255) : out[p + 3];
  }
}

/** Decodes the top mip level to RGBA8. Returns {width, height, rgba, format}. */
export function decodeDds(bytes) {
  const h = readDdsHeader(bytes);
  const { width: w, height: hgt, format } = h;
  const rgba = new Uint8ClampedArray(w * hgt * 4);
  let o = h.dataOffset;
  if (format === 'DXT1' || format === 'DXT3' || format === 'DXT5') {
    const isDxt1 = format === 'DXT1';
    for (let by = 0; by < hgt; by += 4) {
      for (let bx = 0; bx < w; bx += 4) {
        if (format === 'DXT3') {
          for (let i = 0; i < 16; i++) {
            const x = bx + (i & 3), y = by + (i >> 2);
            const nib = (bytes[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
            if (x < w && y < hgt) rgba[(y * w + x) * 4 + 3] = nib * 17;
          }
          o += 8;
        } else if (format === 'DXT5') {
          const a0 = bytes[o], a1 = bytes[o + 1];
          const pal = [a0, a1];
          if (a0 > a1) for (let k = 1; k < 7; k++) pal.push(((7 - k) * a0 + k * a1) / 7 | 0);
          else { for (let k = 1; k < 5; k++) pal.push(((5 - k) * a0 + k * a1) / 5 | 0); pal.push(0, 255); }
          let lo = bytes[o + 2] | (bytes[o + 3] << 8) | (bytes[o + 4] << 16);
          let hi = bytes[o + 5] | (bytes[o + 6] << 8) | (bytes[o + 7] << 16);
          for (let i = 0; i < 16; i++) {
            const idx = i < 8 ? (lo >> (i * 3)) & 7 : (hi >> ((i - 8) * 3)) & 7;
            const x = bx + (i & 3), y = by + (i >> 2);
            if (x < w && y < hgt) rgba[(y * w + x) * 4 + 3] = pal[idx];
          }
          o += 8;
        }
        decodeColorBlock(bytes, o, rgba, w, bx, by, isDxt1);
        o += 8;
      }
    }
    return { width: w, height: hgt, rgba, format };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bpp = h.bits / 8;
  const shift = (m) => (m ? Math.log2(m & -m) : 0);
  const scale = (m) => (m ? 255 / (m >>> shift(m)) : 0);
  for (let i = 0; i < w * hgt; i++) {
    const p = o + i * bpp;
    let v = 0;
    for (let k = 0; k < bpp; k++) v |= bytes[p + k] << (8 * k);
    v >>>= 0;
    const q = i * 4;
    if (format === 'L8') { rgba[q] = rgba[q + 1] = rgba[q + 2] = v; rgba[q + 3] = 255; continue; }
    if (format === 'A8') { rgba[q] = rgba[q + 1] = rgba[q + 2] = 255; rgba[q + 3] = v; continue; }
    if (format === 'A8L8') { rgba[q] = rgba[q + 1] = rgba[q + 2] = v & 255; rgba[q + 3] = v >> 8; continue; }
    const [mr, mg, mb, ma] = h.masks;
    rgba[q] = ((v & mr) >>> shift(mr)) * scale(mr);
    rgba[q + 1] = ((v & mg) >>> shift(mg)) * scale(mg);
    rgba[q + 2] = ((v & mb) >>> shift(mb)) * scale(mb);
    rgba[q + 3] = ma ? ((v & ma) >>> shift(ma)) * scale(ma) : 255;
  }
  void dv;
  return { width: w, height: hgt, rgba, format };
}

// ---------- encoding ----------

function to565(r, g, b) {
  return ((r * 31 / 255 + 0.5) << 11) | ((g * 63 / 255 + 0.5) << 5) | (b * 31 / 255 + 0.5);
}

/** Simple, decent-quality DXT1 colour block: endpoints = min/max along the main colour axis. */
function encodeColorBlock(px, out, o, forceFour) {
  let minL = 1e9, maxL = -1e9, minI = 0, maxI = 0;
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) { mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; }
  mr /= 16; mg /= 16; mb /= 16;
  // principal axis by a few power iterations on the covariance
  let cov = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4] - mr, g = px[i * 4 + 1] - mg, b = px[i * 4 + 2] - mb;
    cov[0] += r * r; cov[1] += r * g; cov[2] += r * b; cov[3] += g * g; cov[4] += g * b; cov[5] += b * b;
  }
  let ax = [1, 1, 1];
  for (let k = 0; k < 4; k++) {
    const x = cov[0] * ax[0] + cov[1] * ax[1] + cov[2] * ax[2];
    const y = cov[1] * ax[0] + cov[3] * ax[1] + cov[4] * ax[2];
    const z = cov[2] * ax[0] + cov[4] * ax[1] + cov[5] * ax[2];
    const len = Math.hypot(x, y, z) || 1;
    ax = [x / len, y / len, z / len];
  }
  for (let i = 0; i < 16; i++) {
    const l = px[i * 4] * ax[0] + px[i * 4 + 1] * ax[1] + px[i * 4 + 2] * ax[2];
    if (l < minL) { minL = l; minI = i; }
    if (l > maxL) { maxL = l; maxI = i; }
  }
  let c0 = to565(px[maxI * 4], px[maxI * 4 + 1], px[maxI * 4 + 2]);
  let c1 = to565(px[minI * 4], px[minI * 4 + 1], px[minI * 4 + 2]);
  if (c0 < c1) [c0, c1] = [c1, c0];
  if (c0 === c1) { if (c0 > 0) c1 = c0 - 1; else c0 = 1; }
  const a = rgb565(c0), b = rgb565(c1);
  const pal = [a, b, a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)];
  let bits = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, bd = 1e12;
    for (let k = 0; k < 4; k++) {
      const d = (px[i * 4] - pal[k][0]) ** 2 + (px[i * 4 + 1] - pal[k][1]) ** 2 + (px[i * 4 + 2] - pal[k][2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    bits |= best << (i * 2);
  }
  void forceFour;
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  out[o + 4] = bits & 255; out[o + 5] = (bits >>> 8) & 255; out[o + 6] = (bits >>> 16) & 255; out[o + 7] = (bits >>> 24) & 255;
}

function encodeAlphaBlock(px, out, o) {
  let a0 = 0, a1 = 255;
  for (let i = 0; i < 16; i++) { a0 = Math.max(a0, px[i * 4 + 3]); a1 = Math.min(a1, px[i * 4 + 3]); }
  if (a0 === a1) { if (a0 < 255) a0++; else a1--; }
  const pal = [a0, a1];
  for (let k = 1; k < 7; k++) pal.push(((7 - k) * a0 + k * a1) / 7);
  let lo = 0, hi = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, bd = 1e9;
    for (let k = 0; k < 8; k++) { const d = Math.abs(px[i * 4 + 3] - pal[k]); if (d < bd) { bd = d; best = k; } }
    if (i < 8) lo |= best << (i * 3); else hi |= best << ((i - 8) * 3);
  }
  out[o] = a0; out[o + 1] = a1;
  out[o + 2] = lo & 255; out[o + 3] = (lo >> 8) & 255; out[o + 4] = (lo >> 16) & 255;
  out[o + 5] = hi & 255; out[o + 6] = (hi >> 8) & 255; out[o + 7] = (hi >> 16) & 255;
}

function halve(rgba, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy);
        s += rgba[(sy * w + sx) * 4 + c]; n++;
      }
      out[(y * nw + x) * 4 + c] = s / n;
    }
  }
  return { rgba: out, w: nw, h: nh };
}

/**
 * Encodes RGBA8 into a DDS file. format: 'DXT1' | 'DXT5' | 'A8R8G8B8'.
 * Width and height must be multiples of 4 for DXT formats.
 */
export function encodeDds(rgba, width, height, format = 'DXT1', mipmaps = true) {
  const levels = [];
  let cur = { rgba, w: width, h: height };
  levels.push(cur);
  if (mipmaps) while (cur.w > 1 || cur.h > 1) { cur = halve(cur.rgba, cur.w, cur.h); levels.push(cur); }
  const blockBytes = format === 'DXT1' ? 8 : 16;
  const sizeOf = (l) => (format === 'A8R8G8B8' ? l.w * l.h * 4 : Math.max(1, Math.ceil(l.w / 4)) * Math.max(1, Math.ceil(l.h / 4)) * blockBytes);
  const total = 128 + levels.reduce((s, l) => s + sizeOf(l), 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x20534444, true);
  dv.setUint32(4, 124, true);
  let flags = 0x1 | 0x2 | 0x4 | 0x1000;
  if (mipmaps) flags |= DDSD_MIPMAPCOUNT;
  flags |= format === 'A8R8G8B8' ? 0x8 : 0x80000;
  dv.setUint32(8, flags, true);
  dv.setUint32(12, height, true);
  dv.setUint32(16, width, true);
  dv.setUint32(20, format === 'A8R8G8B8' ? width * 4 : sizeOf(levels[0]), true);
  dv.setUint32(28, mipmaps ? levels.length : 0, true);
  dv.setUint32(76, 32, true);
  if (format === 'A8R8G8B8') {
    dv.setUint32(80, 0x41, true);
    dv.setUint32(88, 32, true);
    dv.setUint32(92, 0x00ff0000, true); dv.setUint32(96, 0x0000ff00, true);
    dv.setUint32(100, 0x000000ff, true); dv.setUint32(104, 0xff000000, true);
  } else {
    dv.setUint32(80, 0x4, true);
    dv.setUint32(84, fourCC(format), true);
  }
  dv.setUint32(108, 0x1000 | (mipmaps ? 0x400008 : 0), true);
  let o = 128;
  const block = new Uint8ClampedArray(64);
  for (const l of levels) {
    if (format === 'A8R8G8B8') {
      for (let i = 0; i < l.w * l.h; i++) {
        out[o++] = l.rgba[i * 4 + 2]; out[o++] = l.rgba[i * 4 + 1]; out[o++] = l.rgba[i * 4]; out[o++] = l.rgba[i * 4 + 3];
      }
      continue;
    }
    for (let by = 0; by < l.h; by += 4) for (let bx = 0; bx < l.w; bx += 4) {
      for (let i = 0; i < 16; i++) {
        const x = Math.min(l.w - 1, bx + (i & 3)), y = Math.min(l.h - 1, by + (i >> 2));
        for (let c = 0; c < 4; c++) block[i * 4 + c] = l.rgba[(y * l.w + x) * 4 + c];
      }
      if (format === 'DXT5') { encodeAlphaBlock(block, out, o); o += 8; }
      encodeColorBlock(block, out, o);
      o += 8;
    }
  }
  return out;
}
