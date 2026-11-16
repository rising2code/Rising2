// Bots' navigation map (navmesh): collects the level's solid geometry, has the main process
// build the walkable polygons with Recast, finds jump / drop / climb links, draws it all over
// the scene coloured by cost, and keeps the hand-placed markers (avoid / block / ignore /
// walkable boxes, points of interest, manual links). Every rule is in docs/navmesh-assumptions.md.

import * as THREE from 'three';
import { join } from './level.js';
import { categoryOf } from './viewport.js';
import { esc } from './tree.js';

const $ = (id) => document.getElementById(id);

// soldier and movement numbers (docs/navmesh-assumptions.md)
export const NAV = {
  radius: 0.4, heights: [1.8, 1.35, 0.8], step: 0.15, maxSlope: 45, walk: 2.0, g: 9.8,
  jumpUp: 6.0, powerUp: 11.2, climbSpeed: 2.0,
  jumpHeight: 1.6,   // highest ledge a normal jump reaches (apex 1.84 m, minus a margin)
  powerHeight: 6.0,  // the same for the power jump (apex 6.4 m)
  jumpGap: 3.5,      // widest gap a walking jump clears (3.7 m on flat ground)
};
export const AREA_COST = { walk: 1, crouch: 2, prone: 5, avoid: 10 };
const AREA_COLOR = { walk: 0x3ddc84, crouch: 0xf5d142, prone: 0xff8c3a, avoid: 0xff4d6a };
const LINK_COLOR = { jump: 0x40e0ff, power: 0xd070ff, drop: 0x5a8cff, climb: 0xffffff };

export const MARKER_TYPES = {
  avoid: { box: true, color: 0xff4d6a, label: 'Avoid area', help: 'Walkable but costly (cost 10), for example open ground under fire.' },
  block: { box: true, color: 0x888888, label: 'Block area', help: 'Nothing inside is walkable.' },
  ignore: { box: true, color: 0x40c0ff, label: 'Ignore box', help: 'Geometry inside is left out of the build (for models the build gets wrong).' },
  walkable: { box: true, color: 0x3ddc84, label: 'Walkable box', help: 'Floors inside count as walkable even if they are steeper than 45°.' },
  goal: { box: false, color: 0xffd040, label: 'Point of interest', help: 'Exported as a goal the bots can head for (with its name).' },
  link: { box: false, color: 0x40e0ff, label: 'Manual link', help: 'A jump, power jump, drop or climb drawn by hand, from A to B.' },
};

export class NavTool {
  constructor(app) {
    this.app = app;
    this.vp = app.viewport;
    this.markers = [];
    this.nextId = 1;
    this.result = null;
    this.links = [];
    this.show = { mesh: true, fill: true, links: true, markers: true };
    this.overlay = new THREE.Group();
    this.overlay.renderOrder = 2;
    this.markerGroup = new THREE.Group();
    this.vp.scene.add(this.overlay, this.markerGroup);
    this.vp.nav = this; // selection, picking and transforms of markers go through here
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.boxEdges = new THREE.EdgesGeometry(this.boxGeo);
    this.ballGeo = new THREE.SphereGeometry(0.45, 14, 10);
    this.bindUi();
    window.api.onNavProgress((d, n) => this.setInfo(`Building… ${Math.round((d / n) * 100)}% of ${n} tiles`));
  }

  bindUi() {
    $('navBuild').addEventListener('click', () => this.build());
    $('navExport').addEventListener('click', () => this.exportJson());
    for (const k of Object.keys(this.show)) {
      $('navShow_' + k).addEventListener('change', (e) => { this.show[k] = e.target.checked; this.applyVisibility(); });
    }
    $('navAdd').innerHTML = Object.entries(MARKER_TYPES).map(([k, t]) => `<button data-type="${k}" title="${esc(t.help)}">${esc(t.label)}</button>`).join('');
    $('navAdd').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b) this.addMarker(b.dataset.type); });
    $('navList').addEventListener('click', (e) => {
      const r = e.target.closest('[data-id]');
      if (!r) return;
      const t = { nav: Number(r.dataset.id), end: r.dataset.end || undefined };
      if (e.ctrlKey) this.vp.toggleSelect(t); else this.vp.select(t);
      if (e.detail === 2) this.vp.focusSelection();
    });
  }

  setInfo(text) { $('navInfo').textContent = text; }

  // ---------------------------------------------------------------- level / saving

  async setLevel(lv) {
    this.level = lv;
    this.result = null;
    this.links = [];
    this.geom = null;
    this.clearOverlay();
    this.markers = [];
    this.nextId = 1;
    this.editsFile = join(await window.api.appDir(), 'output', lv.name, lv.name + '.navedits.json');
    try {
      if (await window.api.exists(this.editsFile)) {
        const data = JSON.parse(await window.api.readText(this.editsFile, 'utf8'));
        this.markers = (data.markers || []).map((m) => ({ ...m, id: this.nextId++ }));
      }
    } catch (e) { console.warn('navedits', e); }
    this.rebuildMarkers();
    this.setInfo(this.markers.length ? `${this.markers.length} marker(s) loaded. Press Recalculate to build the navigation map.` : 'Press Recalculate to build the navigation map.');
  }

  saveEdits() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const data = { version: 1, level: this.level.name, markers: this.markers.map(({ id, ...m }) => m) };
      window.api.writeFile(this.editsFile, JSON.stringify(data, null, 1));
    }, 300);
  }

  // ---------------------------------------------------------------- markers

  marker(id) { return this.markers.find((m) => m.id === id); }

  snapshot() { return JSON.stringify(this.markers); }

  restore(json) {
    this.markers = JSON.parse(json);
    this.rebuildMarkers();
    this.vp.select(this.vp.selection.filter((t) => !t.nav || this.marker(t.nav)));
    this.app.props.show(this.vp.selection);
    this.saveEdits();
  }

  /** Runs fn (which changes this.markers) as one undoable step. */
  change(label, fn) {
    const before = this.snapshot();
    fn();
    const after = this.snapshot();
    if (before === after) return;
    this.rebuildMarkers();
    this.saveEdits();
    this.app.push(label, () => this.restore(before), () => this.restore(after));
  }

  addMarker(type) {
    if (!this.level) return;
    const p = this.vp.dropPoint();
    const y = Math.max(p.y, this.level.heightAt(p.x, p.z));
    const m = { id: this.nextId++, type };
    if (MARKER_TYPES[type].box) { m.center = [p.x, y + 2, p.z].map(r2); m.size = [10, 4, 10]; }
    else if (type === 'goal') { m.pos = [p.x, y, p.z].map(r2); m.name = 'point ' + m.id; }
    else { m.a = [p.x - 2, y, p.z].map(r2); m.b = [p.x + 2, y, p.z].map(r2); m.kind = 'jump'; m.twoWay = false; }
    this.change('add ' + MARKER_TYPES[type].label.toLowerCase(), () => this.markers.push(m));
    this.vp.select({ nav: m.id, end: type === 'link' ? 'a' : undefined });
    this.app.status(`${MARKER_TYPES[type].label} added at the centre of the view. Move it with the gizmo (1) or scale boxes (3). Recalculate to see the effect.`);
  }

  removeMarkers(ids) {
    this.change(`delete ${ids.length} marker(s)`, () => { this.markers = this.markers.filter((m) => !ids.includes(m.id)); });
  }

  duplicateMarkers(ids) {
    const copies = [];
    this.change('duplicate marker', () => {
      for (const id of ids) {
        const c = JSON.parse(JSON.stringify(this.marker(id)));
        c.id = this.nextId++;
        for (const k of ['center', 'pos', 'a', 'b']) if (c[k]) c[k][0] = r2(c[k][0] + 2);
        if (c.name) c.name += ' copy';
        this.markers.push(c);
        copies.push(c);
      }
    });
    return copies.map((c) => ({ nav: c.id, end: c.type === 'link' ? 'a' : undefined }));
  }

  rebuildMarkers() {
    this.markerGroup.clear();
    this.markerObjs = new Map(); // "id" / "id:a" -> Object3D
    for (const m of this.markers) {
      const t = MARKER_TYPES[m.type];
      const mat = new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: t.box ? 0.18 : 0.85, depthWrite: !t.box, side: THREE.DoubleSide });
      if (t.box) {
        const mesh = new THREE.Mesh(this.boxGeo, mat);
        mesh.position.fromArray(m.center);
        mesh.scale.fromArray(m.size);
        mesh.add(new THREE.LineSegments(this.boxEdges, new THREE.LineBasicMaterial({ color: t.color })));
        mesh.userData.navTarget = { nav: m.id };
        this.markerGroup.add(mesh);
        this.markerObjs.set(String(m.id), mesh);
      } else if (m.type === 'goal') {
        const mesh = new THREE.Mesh(this.ballGeo, mat);
        mesh.position.set(m.pos[0], m.pos[1] + 0.9, m.pos[2]);
        const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.9, 0), new THREE.Vector3(0, 0, 0)]), new THREE.LineBasicMaterial({ color: t.color }));
        mesh.add(pole);
        mesh.userData.navTarget = { nav: m.id };
        this.markerGroup.add(mesh);
        this.markerObjs.set(String(m.id), mesh);
      } else {
        const col = LINK_COLOR[m.kind] ?? t.color;
        for (const end of ['a', 'b']) {
          const mesh = new THREE.Mesh(this.ballGeo, new THREE.MeshBasicMaterial({ color: end === 'a' ? col : 0xffffff, transparent: true, opacity: 0.9 }));
          mesh.position.set(m[end][0], m[end][1] + 0.5, m[end][2]);
          mesh.scale.setScalar(0.7);
          mesh.userData.navTarget = { nav: m.id, end };
          this.markerGroup.add(mesh);
          this.markerObjs.set(m.id + ':' + end, mesh);
        }
        this.markerGroup.add(arcLine(m.a, m.b, m.kind, col, m.twoWay));
      }
    }
    this.renderList();
    this.applyVisibility();
  }

  renderList() {
    const sel = new Set(this.vp.selection.filter((t) => t.nav).map((t) => t.nav));
    $('navList').innerHTML = this.markers.length ? this.markers.map((m) => {
      const t = MARKER_TYPES[m.type];
      const what = m.type === 'goal' ? esc(m.name || '') : m.type === 'link' ? `${m.kind}${m.twoWay ? ' ⇄' : ' →'}` : `${m.size.map((v) => +v.toFixed(1)).join(' × ')} m`;
      return `<div class="pitem ${sel.has(m.id) ? 'sel' : ''}" data-id="${m.id}" ${m.type === 'link' ? 'data-end="a"' : ''}><span class="dot" style="background:#${t.color.toString(16).padStart(6, '0')}"></span>${esc(t.label)} <span class="src">${what}</span></div>`;
    }).join('') : '<div class="muted small" style="padding:4px 8px">No markers. Add one with the buttons above.</div>';
  }

  // hooks used by the viewport for selection and the gizmo
  objectOf(t) { return this.markerObjs?.get(t.end ? t.nav + ':' + t.end : String(t.nav)) || null; }

  pickables() { return this.show.markers ? [...this.markerObjs.values()] : []; }

  isBox(t) { const m = this.marker(t.nav); return !!(m && MARKER_TYPES[m.type].box); }

  capture(t) {
    const m = this.marker(t.nav);
    if (!m) return null;
    return { nav: JSON.stringify({ center: m.center, size: m.size, pos: m.pos, a: m.a, b: m.b }) };
  }

  applySnap(t, snap) {
    const m = this.marker(t.nav);
    if (!m) return;
    Object.assign(m, JSON.parse(snap.nav));
    this.rebuildMarkers();
    this.saveEdits();
  }

  /** Copies a dragged marker object's position / size back into the marker. */
  writeBack(t) {
    const m = this.marker(t.nav), o = this.objectOf(t);
    if (!m || !o) return;
    const p = o.position;
    if (MARKER_TYPES[m.type].box) {
      m.center = [p.x, p.y, p.z].map(r2);
      m.size = [o.scale.x, o.scale.y, o.scale.z].map((v) => r2(Math.max(0.2, Math.abs(v))));
    } else if (m.type === 'goal') m.pos = [p.x, p.y - 0.9, p.z].map(r2);
    else m[t.end] = [p.x, p.y - 0.5, p.z].map(r2);
    o.quaternion.identity(); // markers are not rotated
    if (!MARKER_TYPES[m.type].box) o.scale.setScalar(t.end ? 0.7 : 1);
    this.saveEdits();
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => { this.rebuildMarkers(); this.vp.select(this.vp.selection); }, 0);
  }

  describe(t) {
    const m = this.marker(t.nav);
    return m ? MARKER_TYPES[m.type].label + (m.name ? ' ' + m.name : '') + (t.end ? ` (end ${t.end.toUpperCase()})` : '') : '';
  }

  /** Properties panel for one marker. */
  showProps(el, t) {
    const m = this.marker(t.nav);
    if (!m) { el.innerHTML = ''; return; }
    const T = MARKER_TYPES[m.type];
    const vec = (id, v) => `<div class="vec">${v.map((x, i) => `<input type="number" step="0.1" data-vec="${id}" data-i="${i}" value="${x}">`).join('')}</div>`;
    let h = `<h4>Bot navigation marker</h4><p class="muted small">${esc(T.help)}</p><div class="kv">`;
    if (T.box) {
      h += `<span>Type</span><select id="nmType">${Object.entries(MARKER_TYPES).filter(([, x]) => x.box).map(([k, x]) => `<option value="${k}" ${k === m.type ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`;
      h += `<span>Centre</span>${vec('center', m.center)}<span>Size (m)</span>${vec('size', m.size)}`;
    } else if (m.type === 'goal') {
      h += `<span>Name</span><input id="nmName" value="${esc(m.name || '')}" spellcheck="false"><span>Position</span>${vec('pos', m.pos)}`;
    } else {
      h += `<span>Kind</span><select id="nmKind">${['jump', 'power', 'drop', 'climb'].map((k) => `<option ${k === m.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>`;
      h += `<span>Both ways</span><input type="checkbox" id="nmTwo" ${m.twoWay ? 'checked' : ''}>`;
      h += `<span>From (A)</span>${vec('a', m.a)}<span>To (B)</span>${vec('b', m.b)}`;
    }
    h += `</div><div class="row"><button id="nmDel">Delete</button><button id="nmDup">Duplicate</button></div>`;
    el.innerHTML = h;
    const set = (label, fn) => { this.change(label, fn); this.vp.select(this.vp.selection); this.app.props.show(this.vp.selection); };
    el.querySelector('#nmType')?.addEventListener('change', (e) => set('change marker type', () => { m.type = e.target.value; }));
    el.querySelector('#nmName')?.addEventListener('change', (e) => set('rename point', () => { m.name = e.target.value; }));
    el.querySelector('#nmKind')?.addEventListener('change', (e) => set('change link kind', () => { m.kind = e.target.value; }));
    el.querySelector('#nmTwo')?.addEventListener('change', (e) => set('change link direction', () => { m.twoWay = e.target.checked; }));
    el.querySelectorAll('[data-vec]').forEach((inp) => inp.addEventListener('change', () => set('edit marker', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) m[inp.dataset.vec][Number(inp.dataset.i)] = inp.dataset.vec === 'size' ? Math.max(0.2, v) : v;
    })));
    el.querySelector('#nmDel').addEventListener('click', () => this.app.deleteSelection());
    el.querySelector('#nmDup').addEventListener('click', () => this.app.duplicateSelection());
  }

  boxes(type) {
    return this.markers.filter((m) => m.type === type).map((m) => ({
      min: m.center.map((c, i) => c - m.size[i] / 2), max: m.center.map((c, i) => c + m.size[i] / 2),
    }));
  }

  // ---------------------------------------------------------------- geometry

  /** Is this shape part solid for the soldiers? (docs/navmesh-assumptions.md, section 6) */
  isSolid(g) {
    const node = g.userData.node;
    if (node.cmd('setusephysique')?.args[0] === 'false') return false;
    for (let n = node; n; n = n.parent) {
      if (n.cmd('setintersection')?.args[0] === 'false') return false;
      if (n.name === 'sky' || n.cls === 'nskinanimator' || n.cls === 'ntransformanimator') return false;
    }
    return true;
  }

  /** World-space triangles of the terrain and every solid part, minus the ignore boxes. */
  async gather() {
    const vp = this.vp, lv = this.level;
    const ignore = this.boxes('ignore');
    const inIgnore = (x, y, z) => ignore.some((b) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]);
    const parts = vp.meshes.filter((g) => this.isSolid(g));
    const geos = await Promise.all(parts.map((g) => vp.geometryFor(g.userData.shape.mesh, g.userData.shape.group)));
    const ladders = [];
    let nv = 0, nt = 0;
    const t = lv.terrain;
    if (t) { nv += t.width * t.height; nt += (t.width - 1) * (t.height - 1) * 2; }
    parts.forEach((g, i) => { if (geos[i]) { nv += geos[i].attributes.position.count; nt += geos[i].index.count / 3; } });
    const pos = new Float32Array(nv * 3);
    let idx = new Uint32Array(nt * 3);
    let v = 0, k = 0;
    if (t) {
      for (let j = 0; j < t.height; j++) for (let i = 0; i < t.width; i++) {
        const q = j * t.width + i;
        pos[v * 3] = i * t.spacing; pos[v * 3 + 1] = t.heights[q]; pos[v * 3 + 2] = j * t.spacing;
        v++;
      }
      for (let j = 0; j < t.height - 1; j++) for (let i = 0; i < t.width - 1; i++) {
        const a = j * t.width + i, b = a + 1, c = a + t.width, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const tmp = new THREE.Vector3();
    parts.forEach((g, i) => {
      const geo = geos[i];
      if (!geo) return;
      g.updateWorldMatrix(true, false);
      const P = geo.attributes.position, I = geo.index.array;
      const base = v;
      const box = new THREE.Box3();
      for (let q = 0; q < P.count; q++) {
        tmp.fromBufferAttribute(P, q).applyMatrix4(g.matrixWorld);
        pos[v * 3] = tmp.x; pos[v * 3 + 1] = tmp.y; pos[v * 3 + 2] = tmp.z;
        v++;
      }
      for (let q = 0; q < I.length; q += 3) {
        const a = base + I[q], b = base + I[q + 1], c = base + I[q + 2];
        if (ignore.length && inIgnore((pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3)) continue;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        for (const x of [a, b, c]) box.expandByPoint(tmp.set(pos[x * 3], pos[x * 3 + 1], pos[x * 3 + 2]));
      }
      if (g.userData.node.cmd('setphmaterial')?.args[0] === '4' && !box.isEmpty()) ladders.push({ box, name: g.userData.node.name });
    });
    idx = idx.slice(0, k);
    // the area to build: the terrain square, grown to take in every object
    const bounds = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
    for (let q = 0; q < pos.length; q += 3) for (let a = 0; a < 3; a++) {
      if (pos[q + a] < bounds[0][a]) bounds[0][a] = pos[q + a];
      if (pos[q + a] > bounds[1][a]) bounds[1][a] = pos[q + a];
    }
    return { positions: pos, indices: idx, bounds, ladders, parts: parts.length };
  }

  // ---------------------------------------------------------------- build

  async build() {
    if (!this.level || this.building) return;
    this.building = true;
    $('navBuild').disabled = true;
    try {
      this.setInfo('Loading models…');
      const t0 = performance.now();
      const geom = await this.gather();
      this.geom = geom;
      this.setInfo(`Building from ${(geom.indices.length / 3 / 1e6).toFixed(2)} M triangles (${geom.parts} solid parts)…`);
      const edits = { avoid: this.boxes('avoid'), block: this.boxes('block'), walkable: this.boxes('walkable') };
      const res = await window.api.navBuild({
        positions: geom.positions, indices: geom.indices, bounds: geom.bounds, edits,
        options: { radius: NAV.radius, heights: NAV.heights, step: NAV.step, maxSlope: NAV.maxSlope },
      });
      this.result = res;
      this.setInfo('Finding jumps, drops and ladders…');
      await new Promise((r) => setTimeout(r, 0));
      this.index = new PolyIndex(res);
      this.tris = new TriGrid(geom.positions, geom.indices);
      this.links = findLinks(res, this.index, this.tris, geom.ladders);
      this.drawOverlay();
      const count = {};
      for (const p of res.polygons) count[p.area] = (count[p.area] || 0) + 1;
      const lc = {};
      for (const l of this.links) lc[l.type] = (lc[l.type] || 0) + 1;
      this.setInfo(`${res.polygons.length} polygons (${Object.entries(count).map(([a, n]) => `${n} ${a}`).join(', ')}); `
        + `links: ${Object.entries(lc).map(([a, n]) => `${n} ${a}`).join(', ') || 'none'}. `
        + `${((performance.now() - t0) / 1000).toFixed(1)} s.`);
      this.app.status('Navigation map rebuilt. Green walk, yellow crouch, orange prone, red avoid; links: cyan jump, purple power jump, blue drop, white climb.');
    } catch (e) {
      console.error(e);
      this.setInfo('Build failed: ' + e.message.split('\n')[0]);
    } finally {
      this.building = false;
      $('navBuild').disabled = false;
    }
  }

  // ---------------------------------------------------------------- overlay

  clearOverlay() {
    for (const o of this.overlay.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.overlay.clear();
    this.vp.invalidate();
  }

  drawOverlay() {
    this.clearOverlay();
    const r = this.result;
    if (!r) return;
    const V = r.vertices, lift = 0.06;
    const fillPos = [], fillCol = [], linePos = [], lineCol = [];
    const c = new THREE.Color();
    r.polygons.forEach((p, pi) => {
      c.setHex(AREA_COLOR[p.area] ?? 0xffffff);
      for (let j = 1; j < p.v.length - 1; j++) {
        for (const q of [p.v[0], p.v[j], p.v[j + 1]]) { fillPos.push(V[q * 3], V[q * 3 + 1] + lift, V[q * 3 + 2]); fillCol.push(c.r, c.g, c.b); }
      }
      p.v.forEach((a, j) => {
        const nb = p.neighbours[j];
        if (nb >= 0 && nb < pi) return; // shared edges once
        const b = p.v[(j + 1) % p.v.length];
        const w = nb < 0 ? 1 : 0.55; // outer edges brighter
        linePos.push(V[a * 3], V[a * 3 + 1] + lift, V[a * 3 + 2], V[b * 3], V[b * 3 + 1] + lift, V[b * 3 + 2]);
        lineCol.push(c.r * w, c.g * w, c.b * w, c.r * w, c.g * w, c.b * w);
      });
    });
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillPos, 3));
    fillGeo.setAttribute('color', new THREE.Float32BufferAttribute(fillCol, 3));
    const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    fill.userData.navLayer = 'fill';
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineCol, 3));
    const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    lines.userData.navLayer = 'mesh';
    this.overlay.add(fill, lines);
    const links = new THREE.Group();
    links.userData.navLayer = 'links';
    for (const l of this.links) links.add(arcLine(l.from, l.to, l.type, LINK_COLOR[l.type], l.twoWay));
    this.overlay.add(links);
    this.applyVisibility();
  }

  applyVisibility() {
    for (const o of this.overlay.children) o.visible = !!this.show[o.userData.navLayer];
    this.markerGroup.visible = this.show.markers;
    this.vp.invalidate();
  }

  // ---------------------------------------------------------------- export

  /** The bots' file: polygons, links (found + manual), goals (spawns, flags, points of interest). */
  toJson() {
    const r = this.result, lv = this.level;
    const V = r.vertices;
    const vertices = [];
    for (let i = 0; i < V.length; i += 3) vertices.push([r2(V[i]), r2(V[i + 1]), r2(V[i + 2])]);
    const links = this.links.map((l) => ({ ...l, from: l.from.map(r2), to: l.to.map(r2), cost: r2(l.cost) }));
    for (const m of this.markers.filter((x) => x.type === 'link')) {
      const a = this.index.floorAt(m.a[0], m.a[2], m.a[1] + 1, m.a[1] - 2.5);
      const b = this.index.floorAt(m.b[0], m.b[2], m.b[1] + 1, m.b[1] - 2.5);
      links.push({ type: m.kind, from: m.a, to: m.b, fromPoly: a ? a.poly : -1, toPoly: b ? b.poly : -1, twoWay: !!m.twoWay, cost: r2(linkCost(m.kind, m.a, m.b)), manual: true });
    }
    const goals = [];
    for (const c of lv.root.cmdsNamed('setinsertionpoint')) {
      const a = c.args.map(Number);
      goals.push({ type: 'spawn', side: a[0], group: a[1], pos: [a[2], a[3], a[4]].map(r2) });
    }
    for (const n of lv.entities.children) {
      if (categoryOf(n) !== 'flag') continue;
      const p = n.nums('setposition');
      if (p) goals.push({ type: 'flag', name: n.name, pos: p.map(r2) });
    }
    for (const m of this.markers.filter((x) => x.type === 'goal')) goals.push({ type: 'poi', name: m.name || '', pos: m.pos });
    return {
      version: 1,
      level: lv.name,
      assumptions: { ...NAV, areaCost: AREA_COST, doc: 'docs/navmesh-assumptions.md in the map editor' },
      vertices,
      polygons: r.polygons.map((p) => ({ v: p.v, area: p.area, neighbours: p.neighbours })),
      links,
      goals,
    };
  }

  async exportJson() {
    if (!this.result) { this.setInfo('Press Recalculate first.'); return; }
    const lv = this.level;
    const file = await window.api.saveFile({
      title: 'Export the bots\' navigation map',
      defaultPath: join(await window.api.appDir(), 'output', lv.name, lv.name + '.nav.json'),
      filters: [{ name: 'Navigation map (JSON)', extensions: ['json'] }],
    });
    if (!file) return;
    const text = JSON.stringify(this.toJson());
    await window.api.writeFile(file, new TextEncoder().encode(text));
    this.app.status(`Exported ${file} (${(text.length / 1e6).toFixed(1)} MB).`);
  }
}

// ------------------------------------------------------------------ helpers

const r2 = (x) => Math.round(x * 100) / 100;

function linkCost(type, a, b) {
  const dy = Math.abs(a[1] - b[1]);
  const flat = Math.hypot(a[0] - b[0], a[2] - b[2]);
  let time;
  if (type === 'climb') time = dy / NAV.climbSpeed + flat / NAV.walk;
  else if (type === 'drop') time = Math.sqrt((2 * dy) / NAV.g) + 0.5;
  else if (type === 'power') time = (2 * NAV.powerUp) / NAV.g;
  else time = (2 * NAV.jumpUp) / NAV.g;
  return time * NAV.walk; // in metres of walking, like the polygons
}

/** A line from a to b: an arc for jumps, straight for drops and climbs, with an arrow tick at b. */
function arcLine(a, b, type, color, twoWay) {
  const pts = [];
  const A = new THREE.Vector3(a[0], a[1] + 0.15, a[2]), B = new THREE.Vector3(b[0], b[1] + 0.15, b[2]);
  const up = type === 'jump' || type === 'power' ? Math.max(0.8, Math.abs(A.y - B.y) * 0.3 + 0.8) : 0;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const p = A.clone().lerp(B, t);
    p.y += up * 4 * t * (1 - t);
    pts.push(p);
  }
  // arrow head at b (and at a if both ways)
  const head = (from, to) => {
    const d = to.clone().sub(from).setY(0);
    if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
    d.normalize().multiplyScalar(0.4);
    const side = new THREE.Vector3(-d.z, 0, d.x);
    return [to.clone().sub(d).add(side), to, to, to.clone().sub(d).sub(side)];
  };
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) seg.push(pts[i], pts[i + 1]);
  seg.push(...head(pts[10], pts[12]));
  if (twoWay) seg.push(...head(pts[2], pts[0]));
  const geo = new THREE.BufferGeometry().setFromPoints(seg);
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
  line.renderOrder = 3;
  return line;
}

/** Finds which polygon is under a point, and its height there. */
export class PolyIndex {
  constructor(res, cell = 4) {
    this.res = res;
    this.cell = cell;
    this.grid = new Map();
    const V = res.vertices;
    res.polygons.forEach((p, pi) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, cx = 0, cy = 0, cz = 0;
      for (const v of p.v) {
        x0 = Math.min(x0, V[v * 3]); x1 = Math.max(x1, V[v * 3]); z0 = Math.min(z0, V[v * 3 + 2]); z1 = Math.max(z1, V[v * 3 + 2]);
        cx += V[v * 3]; cy += V[v * 3 + 1]; cz += V[v * 3 + 2];
      }
      p.c = [cx / p.v.length, cz / p.v.length];
      p.c3 = [cx / p.v.length, cy / p.v.length, cz / p.v.length];
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
        const k = i + ',' + j;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(pi);
      }
    });
  }

  /** Height of polygon pi at (x, z), or null when (x, z) is outside it. */
  heightIn(pi, x, z) {
    const V = this.res.vertices, v = this.res.polygons[pi].v;
    const ax = V[v[0] * 3], ay = V[v[0] * 3 + 1], az = V[v[0] * 3 + 2];
    for (let j = 1; j < v.length - 1; j++) {
      const bx = V[v[j] * 3], by = V[v[j] * 3 + 1], bz = V[v[j] * 3 + 2];
      const cx = V[v[j + 1] * 3], cy = V[v[j + 1] * 3 + 1], cz = V[v[j + 1] * 3 + 2];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-4 && l2 >= -1e-4 && l3 >= -1e-4) return l1 * ay + l2 * by + l3 * cy;
    }
    return null;
  }

  /** True if walking from polygon a reaches polygon b within `limit` metres (centre to centre). */
  walkWithin(a, b, limit) {
    const P = this.res.polygons;
    const dist = new Map([[a, 0]]);
    const open = [a];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === b) return true;
      const d0 = dist.get(cur), c = P[cur].c3;
      for (const nb of P[cur].neighbours) {
        if (nb < 0) continue;
        const n = P[nb].c3;
        const d = d0 + Math.hypot(n[0] - c[0], n[1] - c[1], n[2] - c[2]);
        if (d > limit || d >= (dist.get(nb) ?? Infinity)) continue;
        if (!dist.has(nb)) open.push(nb);
        dist.set(nb, d);
      }
    }
    return false;
  }

  /** The highest polygon under (x, z) between yMin and yMax: {poly, y} or null. */
  floorAt(x, z, yMax, yMin) {
    const list = this.grid.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell));
    if (!list) return null;
    let best = null;
    for (const pi of list) {
      const y = this.heightIn(pi, x, z);
      if (y === null || y > yMax || y < yMin) continue;
      if (!best || y > best.y) best = { poly: pi, y };
    }
    return best;
  }
}

/** Uniform grid over the level's triangles, for "is this straight line blocked?" tests. */
export class TriGrid {
  constructor(pos, idx, cell = 4) {
    this.pos = pos; this.idx = idx; this.cell = cell;
    const nt = idx.length / 3;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pos.length; i += 3) { x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]); z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]); }
    this.x0 = x0; this.z0 = z0;
    this.cols = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
    this.rows = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
    const range = (t) => {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k] * 3; a = Math.min(a, pos[v]); b = Math.max(b, pos[v]); c = Math.min(c, pos[v + 2]); d = Math.max(d, pos[v + 2]); }
      return [Math.floor((a - x0) / cell), Math.floor((b - x0) / cell), Math.floor((c - z0) / cell), Math.floor((d - z0) / cell)];
    };
    const counts = new Int32Array(this.cols * this.rows + 1);
    for (let t = 0; t < nt; t++) { const [i0, i1, j0, j1] = range(t); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * this.cols + i]++; }
    this.start = new Int32Array(counts.length + 1);
    for (let i = 0; i < counts.length; i++) this.start[i + 1] = this.start[i] + counts[i];
    this.ids = new Int32Array(this.start[counts.length]);
    const fill = this.start.slice();
    for (let t = 0; t < nt; t++) { const [i0, i1, j0, j1] = range(t); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.ids[fill[j * this.cols + i]++] = t; }
    this.stamp = new Int32Array(nt);
    this.tick = 0;
  }

  /** True if the segment a-b ([x,y,z]) passes through any triangle. */
  blocked(a, b) {
    const c = this.cell, pos = this.pos, idx = this.idx;
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - this.x0) / c)), i1 = Math.min(this.cols - 1, Math.floor((Math.max(a[0], b[0]) - this.x0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(a[2], b[2]) - this.z0) / c)), j1 = Math.min(this.rows - 1, Math.floor((Math.max(a[2], b[2]) - this.z0) / c));
    const tick = ++this.tick;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cellId = j * this.cols + i;
      for (let q = this.start[cellId]; q < this.start[cellId + 1]; q++) {
        const t = this.ids[q];
        if (this.stamp[t] === tick) continue;
        this.stamp[t] = tick;
        // Moller-Trumbore
        const p0 = idx[t * 3] * 3, p1 = idx[t * 3 + 1] * 3, p2 = idx[t * 3 + 2] * 3;
        const e1x = pos[p1] - pos[p0], e1y = pos[p1 + 1] - pos[p0 + 1], e1z = pos[p1 + 2] - pos[p0 + 2];
        const e2x = pos[p2] - pos[p0], e2y = pos[p2 + 1] - pos[p0 + 1], e2z = pos[p2 + 2] - pos[p0 + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = a[0] - pos[p0], ty = a[1] - pos[p0 + 1], tz = a[2] - pos[p0 + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (s > 1e-4 && s < 1 - 1e-4) return true;
      }
    }
    return false;
  }
}

/**
 * Jump, power-jump, drop and climb links (docs/navmesh-assumptions.md, sections 3-5).
 * Probes outwards from every outer polygon edge, every 1.5 m.
 */
export function findLinks(res, index, tris, ladders) {
  const V = res.vertices, links = [];
  const kept = new Map(); // "type:from:to" -> [points], to thin out neighbouring duplicates
  const shortWalk = new Map(); // "from:to" -> a walking route exists that is not much longer
  const add = (type, from, to, fromPoly, toPoly, twoWay = false) => {
    if (fromPoly === toPoly) return;
    // jumps need standing room at take-off and landing (no jumping from or into crouch / prone space)
    if ((type === 'jump' || type === 'power') && !(tall(fromPoly) && tall(toPoly))) return;
    const key = `${type}:${fromPoly}:${toPoly}`;
    const near = kept.get(key) || [];
    if (near.some((p) => Math.hypot(p[0] - from[0], p[2] - from[2]) < 4)) return;
    // a jump or drop is only worth a link when it saves real walking (no hops over every rock)
    if (type !== 'climb') {
      const pk = fromPoly + ':' + toPoly;
      if (!shortWalk.has(pk)) {
        const straight = Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
        shortWalk.set(pk, index.walkWithin(fromPoly, toPoly, straight * 3 + 8));
      }
      if (shortWalk.get(pk)) return;
    }
    near.push(from);
    kept.set(key, near);
    links.push({ type, from, to, fromPoly, toPoly, twoWay, cost: linkCost(type, from, to) });
  };
  const up = (p, h) => [p[0], p[1] + h, p[2]];
  const tall = (pi) => res.polygons[pi].area === 'walk' || res.polygons[pi].area === 'avoid';
  res.polygons.forEach((p, pi) => {
    p.v.forEach((a, j) => {
      if (p.neighbours[j] >= 0) return;
      const b = p.v[(j + 1) % p.v.length];
      const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2], bx = V[b * 3], by = V[b * 3 + 1], bz = V[b * 3 + 2];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.3) return;
      // outward = away from the polygon's centre
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (nx * (mx - p.c[0]) + nz * (mz - p.c[1]) < 0) { nx = -nx; nz = -nz; }
      for (let s = Math.min(0.75, len / 2); s < len; s += 1.5) {
        const t = s / len;
        const P = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t];
        let ledge = false;
        // 1) a lower floor just past the edge: drop down, and jump / power-jump back up
        for (const d of [0.8, 1.4]) {
          const qx = P[0] + nx * d, qz = P[2] + nz * d;
          const f = index.floorAt(qx, qz, P[1] - 0.3, P[1] - 80);
          if (!f || f.poly === pi) continue;
          const L = [qx, f.y, qz];
          if (tris.blocked(up(P, 1.0), [qx, P[1] + 1.0, qz]) || tris.blocked([qx, P[1] + 1.0, qz], up(L, 0.3))) continue;
          ledge = true;
          add('drop', P, L, pi, f.poly);
          const dy = P[1] - f.y;
          // going back up: the space above the landing spot must be open up to the ledge + body
          if (dy <= NAV.powerHeight && !tris.blocked(up(L, 0.3), up(L, dy + 1.0))) {
            add(dy <= NAV.jumpHeight ? 'jump' : 'power', L, P, f.poly, pi);
          }
          break;
        }
        if (ledge) continue;
        // 2) a gap: floor at about the same height a few metres away
        if (index.floorAt(P[0] + nx * 0.8, P[2] + nz * 0.8, P[1] + 0.5, P[1] - 1.5)) continue; // not a gap
        for (let d = 1.5; d <= NAV.jumpGap + 1e-6; d += 0.5) {
          const qx = P[0] + nx * d, qz = P[2] + nz * d;
          const f = index.floorAt(qx, qz, P[1] + 0.8, P[1] - 1.0);
          if (!f || f.poly === pi) continue;
          const L = [qx, f.y, qz];
          if (tris.blocked(up(P, 1.6), up(L, 1.6)) || tris.blocked(up(P, 3.0), up(L, 3.0))) break;
          add('jump', P, L, pi, f.poly);
          break;
        }
      }
    });
  });
  // 3) ladders: material-4 parts taller than 1.5 m join the floor at their foot to the floor at their top
  for (const { box } of ladders) {
    const size = box.getSize(new THREE.Vector3());
    if (size.y < 1.5 || Math.min(size.x, size.z) > 3) continue;
    const c = box.getCenter(new THREE.Vector3());
    const around = (y, yMax, yMin) => {
      let best = null;
      for (const r of [0, 0.8, 1.3, 1.8]) for (let k = 0; k < (r ? 8 : 1); k++) {
        const x = c.x + Math.cos((k * Math.PI) / 4) * r, z = c.z + Math.sin((k * Math.PI) / 4) * r;
        const f = index.floorAt(x, z, yMax, yMin);
        if (!f) continue;
        const score = Math.abs(f.y - y) + r * 0.3;
        if (!best || score < best.score) best = { ...f, x, z, score };
      }
      return best;
    };
    const foot = around(box.min.y, box.min.y + 1.0, box.min.y - 1.5);
    const top = around(box.max.y, box.max.y + 0.6, box.max.y - 1.5);
    if (foot && top && top.y - foot.y > 1.2 && foot.poly !== top.poly) {
      add('climb', [foot.x, foot.y, foot.z], [top.x, top.y, top.z], foot.poly, top.poly, true);
    }
  }
  return links;
}
