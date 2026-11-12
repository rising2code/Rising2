// Wires the panels together and owns editing operations and undo/redo.

import { Level, join, clearCaches } from './level.js';
import { Viewport } from './viewport.js';
import { TreeView, esc } from './tree.js';
import { PropsPanel } from './props.js';
import { PrefabPanel } from './prefabs.js';
import { TexturesTab } from './textures.js';
import { ExportDialog } from './export.js';
import { N2Node, parseN2, writeN2, uniqueChildName, nodeFromTemplate, fmt } from '../lib/n2.js';
import { parseLevelDatEntries } from '../lib/levelfiles.js';

const $ = (id) => document.getElementById(id);
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const CLIP_HEADER = 'RISING2-MAPEDITOR-CLIPBOARD 1';

class App {
  constructor() {
    this.level = null;
    this.undoStack = [];
    this.redoStack = [];
    this.viewport = new Viewport($('viewport'));
    this.tree = new TreeView($('tree'), $('treeFilter'), (target, e) => this.onTreeClick(target, e));
    this.props = new PropsPanel($('props'), this);
    this.prefabs = new PrefabPanel($('prefabList'), $('prefabFilter'), this);
    this.textures = new TexturesTab(this);
    this.exporter = new ExportDialog(this);

    this.viewport.addEventListener('selected', (e) => {
      this.tree.setSelection(e.detail);
      this.props.show(e.detail);
      this.status(this.describeSelection());
    });
    this.viewport.addEventListener('transformed', (e) => this.onTransformed(e.detail));
    this.viewport.addEventListener('moving', () => this.status(this.describeSelection()));
    this.viewport.addEventListener('menu', (e) => this.showMenu(e.detail.x, e.detail.y));
    this.viewport.addEventListener('terrainpainted', (e) => {
      const before = e.detail.before, after = this.level.terrain.heights.slice();
      this.push('paint terrain', () => this.setHeights(before), () => this.setHeights(after));
    });
    this.viewport.addEventListener('brushheight', (e) => { $('brushHeight').value = e.detail; this.status(`Flatten height set to ${e.detail} m`); });
    this.bindUi();
    this.start();
  }

  async start() {
    this.settings = await window.api.loadSettings();
    const args = await window.api.args();
    const i = args.indexOf('--level');
    const dir = i >= 0 ? args[i + 1] : this.settings.lastLevel;
    if (dir && (await window.api.exists(dir))) this.openLevel(dir);
  }

  status(msg) { $('status').textContent = msg; }

  get sel() { return this.viewport.selection; }

  // ------------------------------------------------------------------ UI wiring

  bindUi() {
    $('btnOpen').addEventListener('click', async () => {
      const d = await window.api.openFolder({ title: 'Open a level folder (e.g. Install_4\\data\\levels\\france\\eiffel)', defaultPath: this.level?.dir });
      if (d) this.openLevel(d);
    });
    $('btnSave').addEventListener('click', () => this.saveN2());
    $('btnExport').addEventListener('click', () => this.exporter.open());
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    document.querySelectorAll('#gizmoModes button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    document.querySelectorAll('#viewModes button').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view)));
    $('chkTerrain').addEventListener('change', (e) => this.viewport.setTerrainVisible(e.target.checked));
    $('opacity').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('opacityVal').textContent = Math.round(v * 100) + '%';
      this.viewport.setOpacity(v);
    });
    $('chkSpawns').addEventListener('change', (e) => this.viewport.setSpawnsVisible(e.target.checked));
    $('chkLocal').addEventListener('change', (e) => this.viewport.setSpace(e.target.checked));
    $('chkSnap').addEventListener('change', (e) => this.viewport.setSnap(e.target.checked));
    $('pivotMode').addEventListener('change', (e) => this.viewport.setPivotMode(e.target.value));
    $('btnCopy').addEventListener('click', () => this.duplicateSelection());
    $('btnDelete').addEventListener('click', () => this.deleteSelection());
    $('btnGround').addEventListener('click', () => this.dropToGround());
    $('btnFocus').addEventListener('click', () => this.viewport.focusSelection());
    $('btnUndo').addEventListener('click', () => this.undo());
    $('btnRedo').addEventListener('click', () => this.redo());
    $('btnSavePrefab').addEventListener('click', () => this.savePrefab());
    document.querySelectorAll('.collapsible').forEach((t) => t.addEventListener('click', () => { const p = $(t.dataset.target); p.hidden = !p.hidden; }));
    for (const id of ['brushOp', 'brushRadius', 'brushStrength', 'brushHeight']) {
      $(id).addEventListener('change', () => this.readBrush());
    }
    $('btnTerrainFlat').addEventListener('click', () => this.flattenAll());
    $('tree').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = this.tree.targetAt(e.target);
      if (t && !this.viewport.isSelected(t)) this.viewport.select(t);
      this.showMenu(e.clientX, e.clientY);
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) this.hideMenu(); }, true);

    window.addEventListener('keydown', (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === 's') { e.preventDefault(); this.saveN2(); return; }
      if (typing) return; // Ctrl+C / Ctrl+V in text fields stay normal text copy/paste
      if (e.key === 'Escape') { this.hideMenu(); this.viewport.select(null); return; }
      if (e.ctrlKey && key === 'z') { e.preventDefault(); this.undo(); return; }
      if (e.ctrlKey && key === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.ctrlKey && key === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
      if (e.ctrlKey && key === 'c') { e.preventDefault(); this.copyToClipboard(); return; }
      if (e.ctrlKey && key === 'v') { e.preventDefault(); this.pasteFromClipboard(e.shiftKey); return; }
      if (e.ctrlKey && key === 'a' && $('tab-map').classList.contains('active')) {
        e.preventDefault();
        this.viewport.select(this.level ? this.level.entities.children.map((node) => ({ node })) : null);
        return;
      }
      if (e.ctrlKey || e.altKey) return;
      const mapTab = $('tab-map').classList.contains('active');
      if (mapTab && FLY_KEYS.has(e.code)) { this.viewport.setFlyKey(e.code, true); e.preventDefault(); return; }
      if (key === 'delete') this.deleteSelection();
      else if (key === 'f') this.viewport.focusSelection();
      else if (key === 't') this.viewport.focusTop();
      else if (key === 'g') this.dropToGround();
      else if ('01234'.includes(key)) this.setMode(['select', 'translate', 'rotate', 'scale', 'terrain'][Number(key)]);
      else if ('5678'.includes(key)) this.setView(['boxes', 'solid', 'wire', 'textured'][Number(key) - 5]);
    });
    window.addEventListener('keyup', (e) => { if (FLY_KEYS.has(e.code)) this.viewport.setFlyKey(e.code, false); });
    window.addEventListener('blur', () => { this.viewport.fly.clear(); this.hideMenu(); });
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  onTreeClick(target, e) {
    if (e.shiftKey) this.viewport.select([...this.sel, ...this.tree.rangeTo(target)]);
    else if (e.ctrlKey) this.viewport.toggleSelect(target);
    else this.viewport.select(target);
    if (e.detail === 2 && !e.ctrlKey && !e.shiftKey) this.viewport.focusTop();
  }

  showTab(tab) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
    if (tab === 'map') this.viewport.resize();
    if (tab === 'textures' && this.level && !this.textures.files.length) this.textures.load();
    if (tab === 'info') this.renderInfo();
  }

  setMode(mode) {
    document.querySelectorAll('#gizmoModes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('terrainPanel').hidden = mode !== 'terrain';
    this.readBrush();
    this.viewport.setMode(mode);
    if (mode === 'terrain' && !this.level?.terrain) this.status('This level has no heightmap terrain.');
    if (mode === 'select') this.status('Select tool: drag a rectangle to select (Ctrl/Shift+drag adds). Middle-drag orbits, right-drag pans.');
  }

  async setView(view) {
    document.querySelectorAll('#viewModes button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    if (view !== 'boxes') this.status('Loading models…');
    const t0 = performance.now();
    await this.viewport.setViewMode(view);
    if (view !== 'boxes') this.status(`Models loaded (${this.viewport.meshes.length} parts, ${((performance.now() - t0) / 1000).toFixed(1)} s).`);
  }

  readBrush() {
    Object.assign(this.viewport.brush, {
      op: $('brushOp').value,
      radius: Number($('brushRadius').value) || 10,
      strength: Number($('brushStrength').value) || 0.3,
      height: Number($('brushHeight').value) || 0,
    });
  }

  // ------------------------------------------------------------------ right-click menu

  showMenu(x, y) {
    this.hideMenu();
    const n = this.sel.length;
    const one = n === 1 ? this.sel[0] : null;
    const what = n === 0 ? '' : n === 1 ? (one.spawn ? 'spawn point' : one.node.name) : `${n} objects`;
    const items = [
      ['Duplicate', 'Ctrl+D', () => this.duplicateSelection(), n > 0],
      ['Copy', 'Ctrl+C', () => this.copyToClipboard(), n > 0],
      ['Paste (same position)', 'Ctrl+V', () => this.pasteFromClipboard(false), !!this.level],
      ['Paste at view centre', 'Ctrl+Shift+V', () => this.pasteFromClipboard(true), !!this.level],
      '-',
      ['Delete', 'Del', () => this.deleteSelection(), n > 0],
      ['To ground', 'G', () => this.dropToGround(), n > 0],
      ['Focus', 'F', () => this.viewport.focusSelection(), n > 0],
      ['Top-down close-up', 'T', () => this.viewport.focusTop(), n > 0],
      '-',
      ['Save as prefab…', '', () => this.savePrefab(), !!(one && one.node && one.node.parent)],
    ];
    const m = document.createElement('div');
    m.id = 'ctxMenu';
    m.innerHTML = (what ? `<div class="muted small" style="padding:3px 10px">${esc(what)}</div><hr>` : '') + items.map((it, i) => (it === '-' ? '<hr>'
      : `<button data-i="${i}" ${it[3] ? '' : 'disabled'}><span>${it[0]}</span><kbd>${it[1]}</kbd></button>`)).join('');
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
    m.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      this.hideMenu();
      items[Number(b.dataset.i)][2]();
    });
  }

  hideMenu() { document.getElementById('ctxMenu')?.remove(); }

  // ------------------------------------------------------------------ level

  async openLevel(dir) {
    if (this.dirty && !(await window.api.confirm('Discard unsaved changes?'))) return;
    this.status('Loading ' + dir + ' …');
    try {
      clearCaches();
      const lv = await Level.open(dir);
      this.level = lv;
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this.viewport.setLevel(lv);
      this.tree.setLevel(lv);
      this.props.show([]);
      $('levelName').textContent = `${lv.name} — ${lv.dir}`;
      document.title = `Rising Eagle Map Editor — ${lv.name}`;
      this.settings.lastLevel = dir;
      window.api.saveSettings(this.settings);
      const placed = lv.entities.children.length;
      this.status(`Loaded ${lv.name}: ${placed} placed objects, ${lv.root.cmdsNamed('setinsertionpoint').length} spawn points${lv.terrain ? `, terrain ${lv.terrain.size} m` : ''}.`);
      this.textures.files = [];
      this.props.loadSignatures(lv.home);
      this.prefabs.load(lv);
      if (this.viewport.viewMode !== 'boxes') this.setView(this.viewport.viewMode);
    } catch (e) {
      console.error(e);
      this.status('Could not open level: ' + e.message);
    }
  }

  async saveN2() {
    const lv = this.level;
    if (!lv) return;
    const appDir = await window.api.appDir();
    const file = await window.api.saveFile({
      title: 'Save level script',
      defaultPath: this.lastSave || join(appDir, 'output', lv.name, lv.name + '.n2'),
      filters: [{ name: 'Nebula level script', extensions: ['n2'] }],
    });
    if (!file) return;
    if (file.toLowerCase() === lv.n2Path.toLowerCase() && !(await window.api.confirm('Overwrite the original level script?', 'Keep a backup of ' + lv.n2Path + ' first.'))) return;
    await window.api.writeFile(file, writeN2(lv.doc));
    this.lastSave = file;
    this.dirty = false;
    this.status(`Saved ${file}` + (lv.terrainDirty ? ' — the terrain was edited: use "Export level…" to write the heightmap.' : ''));
  }

  describeSelection() {
    const s = this.sel;
    if (!s.length) return '';
    if (s.length > 1) return `${s.length} selected (${s.filter((t) => t.spawn).length} spawn points)`;
    const o = this.viewport.selectedObject();
    if (!o) return '';
    const p = o.position;
    return `${s[0].spawn ? 'spawn point' : s[0].node.name}  x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}  z ${p.z.toFixed(2)}`;
  }

  // ------------------------------------------------------------------ undo

  push(label, undo, redo) {
    this.undoStack.push({ label, undo, redo });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    a.undo();
    this.redoStack.push(a);
    this.status('Undo: ' + a.label);
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    a.redo();
    this.undoStack.push(a);
    this.status('Redo: ' + a.label);
  }

  // ------------------------------------------------------------------ edits

  snapshot(node) {
    return { cls: node.cls, name: node.name, items: node.items.map((it) => (it.t === 'cmd' ? { t: 'cmd', name: it.name, args: [...it.args] } : it)) };
  }

  restore(node, snap) {
    node.cls = snap.cls;
    node.name = snap.name;
    node.items = snap.items.map((it) => (it.t === 'cmd' ? { t: 'cmd', name: it.name, args: [...it.args] } : it));
    this.viewport.rebuildNode(node);
    this.tree.render();
    if (this.sel.some((t) => t.node === node)) this.props.show(this.sel);
  }

  /** Runs fn (which changes node's commands/name/class) with undo support. */
  editCommands(node, fn) { this.editCommandsMulti([node], fn); }

  editCommandsMulti(nodes, fn) {
    const before = nodes.map((n) => this.snapshot(n));
    fn();
    const after = nodes.map((n) => this.snapshot(n));
    const apply = (snaps) => nodes.forEach((n, i) => this.restore(n, snaps[i]));
    apply(after);
    if (nodes.includes(this.level.root)) this.viewport.buildSpawns();
    this.push('edit properties', () => apply(before), () => apply(after));
  }

  renameNode(node, name) {
    if (!name || name === node.name) return;
    const unique = node.parent.children.some((c) => c !== node && c.name === name) ? uniqueChildName(node.parent, name) : name;
    this.editCommands(node, () => { node.name = unique; });
    if (unique !== name) this.status(`Name taken; used ${unique}`);
  }

  applyTransformSnap(target, snap) {
    if (target.spawn) {
      target.spawn.args.splice(0, target.spawn.args.length, ...snap.spawn);
      const m = this.viewport.spawnObject(target.spawn);
      if (m) this.viewport.applySpawn(m);
    } else {
      const n = target.node;
      for (const k of ['setposition', 'seteuler', 'setscale']) {
        if (snap[k]) n.setCmd(k, snap[k], k === 'setposition' ? ['setlocalbox', 'setviewdistance'] : ['setposition']);
        else if (n.cmd(k)) n.removeCmd(n.cmd(k));
      }
      this.viewport.refreshTransform(n);
    }
  }

  onTransformed({ targets, before, after }) {
    const apply = (snaps) => {
      targets.forEach((t, i) => this.applyTransformSnap(t, snaps[i]));
      this.viewport.select(this.sel); // re-place gizmo / pivot
      this.viewport.invalidate();
    };
    this.props.show(this.sel);
    this.push(targets.length > 1 ? `transform ${targets.length} objects` : 'transform', () => apply(before), () => apply(after));
  }

  editSpawn(cmd, fn) {
    const before = [...cmd.args];
    fn();
    const after = [...cmd.args];
    const apply = (a) => {
      cmd.args.splice(0, cmd.args.length, ...a);
      this.viewport.buildSpawns();
      this.viewport.select({ spawn: cmd });
    };
    apply(after);
    this.push('edit spawn', () => apply(before), () => apply(after));
  }

  isProtected(n) { return !n.parent || n === this.level.entities || n === this.level.terrainNode; }

  /**
   * Adds nodes (under a parent, at an index) and spawn commands in one undoable step,
   * then selects them. items: [{node, parent, index}] and [{spawn, index}].
   */
  addItems(nodeItems, spawnItems, label) {
    const root = this.level.root;
    const doIt = () => {
      for (const it of nodeItems) { it.parent.addChild(it.node, it.index); this.viewport.rebuildNode(it.node); }
      for (const it of spawnItems) root.items.splice(it.index ?? spawnInsertIndex(root), 0, it.spawn);
      if (spawnItems.length) this.viewport.buildSpawns();
      if (nodeItems.length) this.level.structureChanged = true;
      this.tree.render();
      this.viewport.select([...nodeItems.map((i) => ({ node: i.node })), ...spawnItems.map((i) => ({ spawn: i.spawn }))]);
    };
    const undoIt = () => {
      for (const it of nodeItems) { it.parent.removeChild(it.node); this.viewport.removeNodeObject(it.node); }
      for (const it of spawnItems) root.removeCmd(it.spawn);
      if (spawnItems.length) this.viewport.buildSpawns();
      this.viewport.select(null);
      this.tree.render();
    };
    doIt();
    this.push(label, undoIt, doIt);
    this.status(`${label}: ${nodeItems.length} object(s), ${spawnItems.length} spawn point(s)`);
  }

  insertNode(parent, node, idx, label) { this.addItems([{ parent, node, index: idx }], [], label); }

  /** Ctrl+D: copies of everything selected, next to the originals (+2 m on X). */
  duplicateSelection() {
    if (!this.level || !this.sel.length) return;
    const root = this.level.root;
    const nodeItems = [], spawnItems = [];
    for (const t of this.sel) {
      if (t.spawn) {
        const c = { t: 'cmd', name: 'setinsertionpoint', args: [...t.spawn.args] };
        c.args[2] = fmt(Number(c.args[2]) + 1.5);
        spawnItems.push({ spawn: c, index: root.items.indexOf(t.spawn) + 1 + spawnItems.length });
        continue;
      }
      const n = t.node;
      if (this.isProtected(n)) continue;
      const c = n.clone();
      c.name = uniqueChildName(n.parent, n.name);
      // names must be unique among siblings, including other copies made in this step
      while (nodeItems.some((i) => i.parent === n.parent && i.node.name === c.name)) c.name = bump(c.name);
      const p = c.nums('setposition');
      if (p && n.parent === this.level.entities) c.setCmd('setposition', [fmt(p[0] + 2), fmt(p[1]), fmt(p[2])]);
      nodeItems.push({ parent: n.parent, node: c, index: n.parent.items.findIndex((it) => it.node === n) + 1 });
    }
    if (nodeItems.length || spawnItems.length) this.addItems(nodeItems, spawnItems, 'duplicate');
  }

  deleteSelection() {
    if (!this.level || !this.sel.length) return;
    const root = this.level.root;
    const nodes = this.sel.filter((t) => t.node && !this.isProtected(t.node)).map((t) => t.node)
      // deleting a parent already deletes its parts
      .filter((n, _, all) => !all.some((o) => o !== n && isAncestor(o, n)));
    const spawns = this.sel.filter((t) => t.spawn).map((t) => t.spawn);
    if (!nodes.length && !spawns.length) { this.status('This node cannot be deleted.'); return; }
    let undoInfo;
    const doIt = () => {
      undoInfo = {
        nodes: nodes.map((n) => ({ n, parent: n.parent, i: n.parent.items.findIndex((it) => it.node === n) })),
        spawns: spawns.map((c) => ({ c, i: root.items.indexOf(c) })),
      };
      for (const n of nodes) { n.parent.removeChild(n); this.viewport.removeNodeObject(n); }
      for (const c of spawns) root.removeCmd(c);
      if (spawns.length) this.viewport.buildSpawns();
      if (nodes.length) this.level.structureChanged = true;
      this.viewport.select(null);
      this.tree.render();
    };
    const undoIt = () => {
      for (const { n, parent, i } of [...undoInfo.nodes].sort((a, b) => a.i - b.i)) { parent.addChild(n, i); this.viewport.rebuildNode(n); }
      for (const { c, i } of [...undoInfo.spawns].sort((a, b) => a.i - b.i)) root.items.splice(i, 0, c);
      if (spawns.length) this.viewport.buildSpawns();
      this.tree.render();
      this.viewport.select([...nodes.map((node) => ({ node })), ...spawns.map((spawn) => ({ spawn }))]);
    };
    doIt();
    this.push(`delete ${nodes.length + spawns.length}`, undoIt, doIt);
    this.status(`Deleted ${nodes.length} object(s) and ${spawns.length} spawn point(s) (Ctrl+Z to undo)`);
  }

  dropToGround() {
    const targets = [...this.sel];
    if (!targets.length) return;
    const before = targets.map((t) => this.viewport.captureTransform(t));
    if (!this.viewport.dropToGround()) return;
    for (const t of targets) this.viewport.writeBack(t);
    this.onTransformed({ targets, before, after: targets.map((t) => this.viewport.captureTransform(t)) });
    this.viewport.select(this.sel);
  }

  placeTemplate(text, baseName) {
    const lv = this.level;
    if (!lv) return;
    const node = nodeFromTemplate(text, uniqueChildName(lv.entities, baseName + '?0'));
    const p = this.viewport.dropPoint();
    node.setCmd('setposition', [fmt(p.x), fmt(lv.heightAt(p.x, p.z)), fmt(p.z)], ['setlocalbox', 'setviewdistance']);
    this.insertNode(lv.entities, node, undefined, 'place ' + baseName);
  }

  savePrefab() {
    const t = this.sel.length === 1 ? this.sel[0] : null;
    if (t && t.node && t.node.parent) this.prefabs.saveSelected(t.node);
    else this.status('Select one object to save it as a prefab.');
  }

  // ------------------------------------------------------------------ clipboard (works between editors)

  /**
   * Ctrl+C puts the selection on the Windows clipboard as text, so another editor window
   * (or another copy of the editor with another level) can paste it with Ctrl+V.
   */
  async copyToClipboard() {
    const lv = this.level;
    if (!lv || !this.sel.length) return;
    const items = [];
    for (const t of this.sel) {
      if (t.spawn) {
        const a = t.spawn.args.map(Number);
        items.push({ kind: 'spawn', args: [...t.spawn.args], groundY: lv.heightAt(a[2], a[4]) });
        continue;
      }
      const n = t.node;
      if (this.isProtected(n)) continue;
      const c = n.clone();
      // a part copied out of its object gets its world position, since it is pasted as an object
      if (n.parent !== lv.entities) {
        const w = this.viewport.worldTransformArgs(n);
        if (w) for (const k of ['setposition', 'seteuler', 'setscale']) c.setCmd(k, w[k], ['setlocalbox']);
      }
      const wrapper = new N2Node('nroot', null);
      wrapper.addChild(c);
      const p = c.nums('setposition') || [0, 0, 0];
      items.push({
        kind: 'node',
        n2: writeN2({ root: wrapper, eol: '\n', trailingNewline: true }),
        origPaths: [...n.walk()].map((x) => x.origPath),
        groundY: lv.heightAt(p[0], p[2]),
      });
    }
    if (!items.length) return;
    const data = { level: lv.dir.toLowerCase(), home: lv.home.toLowerCase(), items };
    await window.api.clipboardWrite(CLIP_HEADER + '\n' + JSON.stringify(data));
    this.status(`Copied ${items.length} item(s). Paste with Ctrl+V here or in another editor window.`);
  }

  /** Ctrl+V: paste at the same coordinates; Ctrl+Shift+V: paste centred on the view, kept on the ground. */
  async pasteFromClipboard(atView) {
    const lv = this.level;
    if (!lv) return;
    const text = await window.api.clipboardRead();
    if (!text || !text.startsWith(CLIP_HEADER)) { this.status('The clipboard holds no map objects (copy some with Ctrl+C first).'); return; }
    let data;
    try { data = JSON.parse(text.slice(CLIP_HEADER.length)); } catch { this.status('The clipboard data is damaged.'); return; }
    const sameLevel = data.level === lv.dir.toLowerCase();
    // where the copied items are, so they can be moved as a group
    const pts = data.items.map((it) => {
      if (it.kind === 'spawn') return [Number(it.args[2]), Number(it.args[4])];
      const p = parseN2(it.n2).root.children[0].nums('setposition') || [0, 0, 0];
      return [p[0], p[2]];
    });
    let dx = 0, dz = 0;
    if (atView) {
      const c = this.viewport.dropPoint();
      const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, mz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      dx = c.x - mx; dz = c.z - mz;
    }
    const nodeItems = [], spawnItems = [];
    for (const it of data.items) {
      if (it.kind === 'spawn') {
        const a = [...it.args];
        const x = Number(a[2]) + dx, z = Number(a[4]) + dz;
        a[2] = fmt(x); a[4] = fmt(z);
        if (atView) a[3] = fmt(lv.heightAt(x, z) + (Number(it.args[3]) - it.groundY));
        spawnItems.push({ spawn: { t: 'cmd', name: 'setinsertionpoint', args: a } });
        continue;
      }
      const node = parseN2(it.n2).root.children[0];
      node.parent = null;
      // baked lighting only exists in the level it came from
      const walk = [...node.walk()];
      walk.forEach((x, i) => { x.origPath = sameLevel ? it.origPaths[i] ?? null : null; });
      node.name = uniqueChildName(lv.entities, node.name);
      while (nodeItems.some((i) => i.node.name === node.name)) node.name = bump(node.name);
      if (atView) {
        const p = node.nums('setposition') || [0, 0, 0];
        const x = p[0] + dx, z = p[2] + dz;
        node.setCmd('setposition', [fmt(x), fmt(lv.heightAt(x, z) + (p[1] - it.groundY)), fmt(z)], ['setlocalbox', 'setviewdistance']);
      }
      nodeItems.push({ parent: lv.entities, node, index: undefined });
    }
    this.addItems(nodeItems, spawnItems, sameLevel ? 'paste' : 'paste from another level');
    if (!sameLevel && nodeItems.length) this.status(`Pasted ${nodeItems.length} object(s) from another level. They have no baked lighting here and will look fully lit in game.`);
  }

  // ------------------------------------------------------------------ terrain

  setHeights(h) {
    this.level.terrain.heights.set(h);
    this.level.terrainDirty = true;
    this.viewport.rebuildTerrainAll();
  }

  async flattenAll() {
    const t = this.level?.terrain;
    if (!t) return;
    const v = Number($('brushHeight').value) || 0;
    if (!(await window.api.confirm(`Set the whole terrain to ${v} m?`))) return;
    const before = t.heights.slice();
    const after = new Float32Array(before.length).fill(v);
    this.setHeights(after);
    this.push('flatten terrain', () => this.setHeights(before), () => this.setHeights(after));
  }

  // ------------------------------------------------------------------ level info (.dat)

  renderInfo() {
    const lv = this.level;
    const form = $('infoForm');
    if (!lv || lv.datText === null) { form.innerHTML = '<p class="muted">No .dat file for this level.</p>'; return; }
    const entries = parseLevelDatEntries(lv.datText);
    let mission = '';
    form.innerHTML = entries.map((e, i) => {
      if (e.key === 'Mission') mission = e.value;
      const label = e.key === 'Mission' || e.key === 'Name' ? `<b>${esc(e.key)}</b>` : `${esc(e.key)}${mission ? ` <span class="muted small">(${esc(mission)})</span>` : ''}`;
      return `<label>${label}</label><textarea data-i="${i}" spellcheck="true">${esc(e.value)}</textarea>`;
    }).join('');
    form.querySelectorAll('textarea').forEach((ta) => ta.addEventListener('change', () => {
      const cur = parseLevelDatEntries(lv.datText);
      const e = cur[Number(ta.dataset.i)];
      const value = ta.value.replace(/#/g, '').replace(/\n/g, ' ');
      lv.datText = lv.datText.slice(0, e.start) + `[${e.key}]${value}#` + lv.datText.slice(e.end);
      lv.datDirty = true;
      this.dirty = true;
      this.status('Level info changed; saved by "Export level…".');
    }));
  }
}

function isAncestor(a, b) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }

function bump(name) {
  const i = name.lastIndexOf('?');
  return i < 0 ? name + '?0' : `${name.slice(0, i)}?${(parseInt(name.slice(i + 1), 10) || 0) + 1}`;
}

/** New spawn points go right after the last existing .setinsertionpoint line. */
function spawnInsertIndex(root) {
  let last = -1;
  root.items.forEach((it, i) => { if (it.t === 'cmd' && it.name === 'setinsertionpoint') last = i; });
  if (last >= 0) return last + 1;
  const firstNode = root.items.findIndex((it) => it.t === 'node');
  return firstNode < 0 ? root.items.length : firstNode;
}

window.app = new App();
