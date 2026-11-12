// Textures tab: browse and preview DDS textures, export them as PNG, convert images into
// new DDS files, and assign a texture to the selected object.

import { decodeDds, encodeDds, readDdsHeader } from '../lib/dds.js';
import { join } from './level.js';
import { esc } from './tree.js';
import { unquote, quote } from '../lib/n2.js';

export class TexturesTab {
  constructor(app) {
    this.app = app;
    this.list = document.getElementById('texList');
    this.filter = document.getElementById('texFilter');
    this.rootSel = document.getElementById('texRoot');
    this.canvas = document.getElementById('texCanvas');
    this.info = document.getElementById('texInfo');
    this.files = [];
    this.current = null;
    this.filter.addEventListener('input', () => this.render());
    this.rootSel.addEventListener('change', () => this.load());
    this.list.addEventListener('click', (e) => {
      const it = e.target.closest('.pitem');
      if (it) this.show(this.files[Number(it.dataset.i)]);
    });
    document.getElementById('btnTexExport').addEventListener('click', () => this.exportPng());
    document.getElementById('btnTexImport').addEventListener('click', () => this.importImage());
    document.getElementById('btnTexApply').addEventListener('click', () => this.applyToSelection());
  }

  rootDir() {
    const lv = this.app.level;
    const v = this.rootSel.value;
    if (v === 'level') return lv.dir;
    if (v === 'common') return join(lv.home, 'common');
    return join(lv.home, 'data', v);
  }

  async load() {
    if (!this.app.level) return;
    this.base = this.rootDir();
    this.files = await window.api.listRecursive(this.base, ['.dds']);
    this.render();
  }

  render() {
    const f = this.filter.value.trim().toLowerCase();
    const rows = [];
    this.files.forEach((p, i) => {
      const rel = p.slice(this.base.length + 1);
      if (f && !rel.toLowerCase().includes(f)) return;
      if (rows.length < 3000) rows.push(`<div class="pitem" data-i="${i}" title="${esc(p)}">${esc(rel)}</div>`);
    });
    this.list.innerHTML = rows.join('') || '<p class="muted" style="padding:8px">No .dds files.</p>';
  }

  async show(path) {
    this.current = path;
    const bytes = await window.api.readBinary(path);
    try {
      const h = readDdsHeader(bytes);
      const img = decodeDds(bytes);
      this.canvas.width = img.width;
      this.canvas.height = img.height;
      this.canvas.getContext('2d').putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
      this.info.textContent = `${h.width}×${h.height} · ${h.format} · ${h.mipCount} mip level(s) · ${this.app.level.toAssign(path)}`;
    } catch (e) {
      this.info.textContent = `${path}: ${e.message}`;
    }
  }

  async exportPng() {
    if (!this.current) return;
    const out = await window.api.saveFile({ title: 'Export PNG', defaultPath: this.current.replace(/\.dds$/i, '.png'), filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!out) return;
    const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/png'));
    await window.api.writeFile(out, new Uint8Array(await blob.arrayBuffer()));
    this.app.status('Exported ' + out);
  }

  async importImage() {
    const src = await window.api.openFile({ title: 'Image to convert', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }] });
    if (!src) return;
    const bytes = await window.api.readBinary(src);
    const bmp = await createImageBitmap(new Blob([bytes]));
    // DXT needs multiples of 4; the game's textures are powers of two, so round to that
    const pow2 = (v) => 2 ** Math.round(Math.log2(Math.max(4, v)));
    const w = pow2(bmp.width), h = pow2(bmp.height);
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    let hasAlpha = false;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) { hasAlpha = true; break; }
    const format = hasAlpha ? 'DXT5' : 'DXT1';
    const out = await window.api.saveFile({
      title: `Save ${format} texture (${w}×${h})`,
      defaultPath: join(this.base || this.app.level.dir, src.split(/[\\/]/).pop().replace(/\.[^.]+$/, '.dds')),
      filters: [{ name: 'DDS texture', extensions: ['dds'] }],
    });
    if (!out) return;
    await window.api.writeFile(out, encodeDds(rgba, w, h, format, true));
    this.app.status(`Wrote ${out} (${w}×${h} ${format} with mipmaps)`);
    await this.load();
    this.show(out);
  }

  applyToSelection() {
    const nodes = this.app.viewport.selection.filter((t) => t.node).map((t) => t.node);
    if (!this.current || !nodes.length) { this.app.status('Pick a texture and select an object first.'); return; }
    const assign = this.app.level.toAssign(this.current);
    const shapes = [...new Set(nodes.flatMap((n) => [...n.walk()]))].filter((n) => n.cmdsNamed('settexture').some((c) => unquote(c.args[0]) === 'DiffMap0'));
    if (!shapes.length) { this.app.status('The selected object has no DiffMap0 texture.'); return; }
    this.app.editCommandsMulti(shapes, () => {
      for (const n of shapes) for (const c of n.cmdsNamed('settexture')) if (unquote(c.args[0]) === 'DiffMap0') c.args[1] = quote(assign);
    });
    this.app.status(`Set DiffMap0 = ${assign} on ${shapes.length} part(s). Note: lightmapped objects in this game normally use atlas textures (static.tai).`);
  }
}
