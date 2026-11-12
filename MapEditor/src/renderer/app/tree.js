// Left panel: the object hierarchy of the level (.n2 nodes) plus the spawn points.

import { CATEGORY, categoryOf } from './viewport.js';

export class TreeView {
  constructor(el, filterInput, onSelect) {
    this.el = el;
    this.filterInput = filterInput;
    this.onSelect = onSelect;
    this.level = null;
    this.expanded = new Set();
    this.selection = [];
    this.anchor = null;
    filterInput.addEventListener('input', () => this.render());
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('keydown', (e) => this.onKey(e));
    el.tabIndex = 0;
  }

  setLevel(level) {
    this.level = level;
    this.expanded = new Set(['root', level.entities.uid]);
    this.selection = [];
    this.anchor = null;
    this.render();
  }

  /** Flat list of visible rows. */
  rows() {
    const lv = this.level;
    if (!lv) return [];
    const out = [];
    const filter = this.filterInput.value.trim().toLowerCase();
    out.push({ key: 'root', depth: 0, label: 'Level settings', cls: lv.root.cls, node: lv.root, leaf: true });
    const spawns = lv.root.cmdsNamed('setinsertionpoint');
    out.push({ key: 'spawns', depth: 0, label: `Spawn points (${spawns.length})`, leaf: spawns.length === 0, open: this.expanded.has('spawns') });
    if (this.expanded.has('spawns')) {
      spawns.forEach((c, i) => {
        const label = `side ${c.args[0]} · group ${c.args[1]} · #${i}`;
        if (!filter || label.includes(filter)) out.push({ key: 'sp' + i, depth: 1, label, spawn: c, leaf: true, color: ['#4f9dff', '#ff5a4f'][Number(c.args[0])] || '#ccc' });
      });
    }
    const visit = (node, depth) => {
      const kids = node.children;
      const match = !filter || node.name.toLowerCase().includes(filter);
      if (filter && depth >= 1 && node.parent === lv.entities) {
        if (!match) return; // filtering works on the placed objects
      }
      const open = this.expanded.has(node.uid);
      out.push({ key: node.uid, depth, label: node.name, cls: node.cls, node, leaf: kids.length === 0, open, color: '#' + CATEGORY[categoryOf(node)].color.toString(16).padStart(6, '0') });
      if (open) for (const c of kids) visit(c, depth + 1);
    };
    for (const c of lv.root.children) visit(c, 0);
    return out;
  }

  isSel(r) {
    return this.selection.some((s) => (s.node && r.node === s.node) || (s.spawn && r.spawn === s.spawn));
  }

  render() {
    const rows = this.rows();
    this._rows = rows;
    const html = rows.map((r, i) => {
      const isSel = this.isSel(r);
      const tw = r.leaf ? '' : r.open ? '▾' : '▸';
      const dot = r.color ? `<span class="dot" style="background:${r.color}"></span>` : '';
      return `<div class="tnode${isSel ? ' sel' : ''}" data-i="${i}" style="padding-left:${4 + r.depth * 14}px"><span class="tw" data-tw="1">${tw}</span>${dot}<span>${esc(r.label)}</span>${r.cls ? `<span class="cls">${esc(r.cls)}</span>` : ''}</div>`;
    });
    this.el.innerHTML = html.join('');
    const sels = this.el.querySelectorAll('.tnode.sel');
    const selEl = this._scrollToActive === false ? null : sels[sels.length - 1];
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  onClick(e) {
    const rowEl = e.target.closest('.tnode');
    if (!rowEl) return;
    const r = this._rows[Number(rowEl.dataset.i)];
    // the ▸ arrow (or double-clicking a folder-like row) expands; double-click a row = close-up
    if (e.target.dataset.tw || r.key === 'spawns' || (e.detail === 2 && r.node && !r.node.parent)) {
      if (!r.leaf && e.detail === 1) {
        if (this.expanded.has(r.key)) this.expanded.delete(r.key); else this.expanded.add(r.key);
        this.render();
      }
      return;
    }
    const target = r.spawn ? { spawn: r.spawn } : { node: r.node };
    if (!e.shiftKey) this.anchor = target; // start of a Shift+click range
    this.onSelect(target, e);
  }

  /** The target of the row under a DOM element (for right-click), or null. */
  targetAt(el) {
    const rowEl = el.closest('.tnode');
    if (!rowEl || !this._rows) return null;
    const r = this._rows[Number(rowEl.dataset.i)];
    return r.spawn ? { spawn: r.spawn } : r.node ? { node: r.node } : null;
  }

  /** Targets of the visible rows from the last plain click to `target` (Shift+click). */
  rangeTo(target) {
    const idx = (t) => this._rows.findIndex((r) => (t.node && r.node === t.node) || (t.spawn && r.spawn === t.spawn));
    const a = this.anchor ? idx(this.anchor) : -1, b = idx(target);
    if (a < 0 || b < 0) return [target];
    const out = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      const r = this._rows[i];
      if (r.spawn) out.push({ spawn: r.spawn });
      else if (r.node && r.node.parent) out.push({ node: r.node });
    }
    return out;
  }

  onKey(e) {
    if (!this._rows || !this.selection.length) return;
    const last = this.selection[this.selection.length - 1];
    const i = this._rows.findIndex((r) => (last.node && r.node === last.node) || (last.spawn && r.spawn === last.spawn));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const r = this._rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (r && (r.node || r.spawn)) this.onSelect(r.spawn ? { spawn: r.spawn } : { node: r.node }, e);
      e.preventDefault();
    }
  }

  /** Highlights the selection (an array), expanding the parents of what is selected. */
  setSelection(sel) {
    this.selection = sel || [];
    for (const s of this.selection.slice(-50)) {
      if (s.node) for (let p = s.node.parent; p; p = p.parent) this.expanded.add(p.uid);
      if (s.spawn) this.expanded.add('spawns');
    }
    this.render();
  }
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
