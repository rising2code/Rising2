// Right panel: properties of the selected node. Every ".command args" line of the node is
// editable as text; position / rotation / scale also get number fields.
// Command signatures (argument types) come from the game exe's script interface strings
// such as "v_setinsertionpoint_iiffffff" (i = int, f = float, s = string, b = bool).

import { tokenize, fmt } from '../lib/n2.js';
import { esc } from './tree.js';
import { join } from './level.js';

const TYPE_NAMES = { i: 'int', f: 'float', s: 'string', b: 'bool', o: 'object', l: 'list' };

export class PropsPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.target = null;
    this.signatures = new Map();
  }

  /** Reads command names and argument types out of RisingEagle.exe (read-only). */
  async loadSignatures(home) {
    this.signatures.clear();
    for (const exe of ['RisingEagle.exe.original', 'RisingEagle.exe', 'Official_DedicatedServer_131.exe']) {
      const p = join(home, 'bin', 'win32', exe);
      if (!(await window.api.exists(p))) continue;
      const bytes = await window.api.readBinary(p);
      const text = new TextDecoder('latin1').decode(bytes);
      const re = /(?<![A-Za-z0-9_])([a-z])_([a-z][a-z0-9]*)_([a-z]*)\0/g;
      let m;
      while ((m = re.exec(text))) {
        if (!this.signatures.has(m[2])) this.signatures.set(m[2], { ret: m[1], args: m[3] });
      }
      break;
    }
    const dl = document.getElementById('cmdNames') || document.body.appendChild(Object.assign(document.createElement('datalist'), { id: 'cmdNames' }));
    dl.innerHTML = [...this.signatures.keys()].filter((k) => k.startsWith('set') || k.startsWith('add')).sort().map((k) => `<option value="${k}">`).join('');
  }

  sigText(name) {
    const s = this.signatures.get(name);
    if (!s) return 'unknown command (not found in the game exe)';
    return s.args ? s.args.split('').map((c) => TYPE_NAMES[c] || c).join(', ') : 'no arguments';
  }

  show(sel) {
    const list = Array.isArray(sel) ? sel : sel ? [sel] : [];
    if (list.length > 1) return this.showMulti(list);
    const target = list[0] || null;
    this.target = target;
    const el = this.el;
    if (!target) { el.innerHTML = '<p class="muted">Select an object. Ctrl+click or the Select tool (0) picks several.</p>'; return; }
    if (target.spawn) return this.showSpawn(target.spawn);
    if (target.nav) return this.app.nav.showProps(el, target);
    const n = target.node;
    const isRoot = !n.parent;
    let h = '';
    h += `<div class="kv">
      <span>Class</span><input id="pCls" value="${esc(n.cls)}" ${isRoot ? 'disabled' : ''} spellcheck="false">
      <span>Name</span><input id="pName" value="${esc(n.name ?? '(level)')}" ${isRoot ? 'disabled' : ''} spellcheck="false">
      <span>Path</span><span class="muted small" style="word-break:break-all">${esc(n.path() || '/')}</span>
    </div>`;
    if (!isRoot) {
      const vec = (id, label, v) => `<span>${label}</span><span class="vec">${v.map((x, i) => `<input type="number" step="any" data-vec="${id}" data-i="${i}" value="${Number(x).toFixed(3)}">`).join('')}</span>`;
      h += '<h4>Transform</h4><div class="kv">';
      h += vec('setposition', 'Position', n.nums('setposition') || [0, 0, 0]);
      h += vec('seteuler', 'Rotation °', n.nums('seteuler') || [0, 0, 0]);
      h += vec('setscale', 'Scale', n.nums('setscale') || [1, 1, 1]);
      h += '</div>';
    }
    h += `<h4>Commands (${n.commands.length})</h4>`;
    n.items.forEach((it, idx) => {
      if (it.t !== 'cmd') return;
      h += `<div class="cmd"><span class="cname" title="${esc(it.name)}: ${esc(this.sigText(it.name))}">.${esc(it.name)}</span><input data-cmd="${idx}" value="${esc(it.args.join(' '))}" spellcheck="false"><button data-del="${idx}" title="Remove command">×</button></div>`;
    });
    h += `<div class="addcmd"><input id="pNewName" list="cmdNames" placeholder="command" spellcheck="false"><input id="pNewArgs" placeholder="arguments" spellcheck="false"><button id="pAdd" title="Add command">+</button></div>`;
    h += `<p class="muted small" id="pSig"></p>`;
    if (n.children.length) h += `<p class="muted small">${n.children.length} child node(s) — expand it in the tree.</p>`;
    el.innerHTML = h;

    el.querySelectorAll('[data-vec]').forEach((inp) => inp.addEventListener('change', () => {
      const name = inp.dataset.vec;
      const vals = [...el.querySelectorAll(`[data-vec="${name}"]`)].map((x) => fmt(Number(x.value)));
      this.app.editCommands(n, () => n.setCmd(name, vals, name === 'setposition' ? ['setlocalbox', 'setviewdistance'] : ['setposition', 'setlocalbox']));
    }));
    el.querySelectorAll('[data-cmd]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const it = n.items[Number(inp.dataset.cmd)];
        this.app.editCommands(n, () => { it.args = tokenize(inp.value); });
      });
      inp.addEventListener('focus', () => { el.querySelector('#pSig').textContent = `.${n.items[Number(inp.dataset.cmd)].name}(${this.sigText(n.items[Number(inp.dataset.cmd)].name)})`; });
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const it = n.items[Number(b.dataset.del)];
      this.app.editCommands(n, () => n.removeCmd(it));
    }));
    const add = () => {
      const name = el.querySelector('#pNewName').value.trim().replace(/^\./, '');
      if (!name) return;
      const args = tokenize(el.querySelector('#pNewArgs').value);
      this.app.editCommands(n, () => {
        const firstNode = n.items.findIndex((i) => i.t === 'node');
        const item = { t: 'cmd', name, args };
        if (firstNode < 0) n.items.push(item); else n.items.splice(firstNode, 0, item);
      });
    };
    el.querySelector('#pAdd').addEventListener('click', add);
    el.querySelector('#pNewArgs').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    el.querySelector('#pNewName').addEventListener('input', (e) => { el.querySelector('#pSig').textContent = e.target.value ? `.${e.target.value}(${this.sigText(e.target.value.replace(/^\./, ''))})` : ''; });
    if (!isRoot) {
      el.querySelector('#pName').addEventListener('change', (e) => this.app.renameNode(n, e.target.value.trim()));
      el.querySelector('#pCls').addEventListener('change', (e) => this.app.editCommands(n, () => { n.cls = e.target.value.trim(); }));
    }
  }

  showMulti(list) {
    const nodes = list.filter((t) => t.node), spawns = list.filter((t) => t.spawn);
    const names = nodes.slice(0, 40).map((t) => `<div class="small">${esc(t.node.name)} <span class="muted">${esc(t.node.cls)}</span></div>`).join('');
    this.el.innerHTML = `
      <p><b>${list.length} selected</b> — ${nodes.length} object(s), ${spawns.length} spawn point(s).</p>
      <p class="muted small">Move, rotate and scale act on all of them together.
      <b>Pivot</b> (toolbar) chooses what they turn and scale around: the selection centre,
      the active object (the one picked last), or each object's own origin.
      <b>Local axes</b> lines the gizmo up with the active object.</p>
      <div class="row"><button id="mDup">Duplicate</button><button id="mCopy">Copy</button><button id="mDel">Delete</button><button id="mGround">To ground</button></div>
      <h4>Selected</h4>${names}${nodes.length > 40 ? `<div class="muted small">… and ${nodes.length - 40} more</div>` : ''}`;
    this.el.querySelector('#mDup').addEventListener('click', () => this.app.duplicateSelection());
    this.el.querySelector('#mCopy').addEventListener('click', () => this.app.copyToClipboard());
    this.el.querySelector('#mDel').addEventListener('click', () => this.app.deleteSelection());
    this.el.querySelector('#mGround').addEventListener('click', () => this.app.dropToGround());
  }

  showSpawn(c) {
    const a = c.args;
    const idx = this.app.level.root.cmdsNamed('setinsertionpoint').indexOf(c);
    this.el.innerHTML = `<div class="kv">
      <span>Spawn point</span><span>#${idx}</span>
      <span>Side</span><input type="number" data-a="0" value="${esc(a[0])}" step="1">
      <span>Group</span><input type="number" data-a="1" value="${esc(a[1])}" step="1">
      <span>Position</span><span class="vec">${[2, 3, 4].map((i) => `<input type="number" step="any" data-a="${i}" value="${Number(a[i]).toFixed(3)}">`).join('')}</span>
      <span>Rotation (rad)</span><span class="vec">${[5, 6, 7].map((i) => `<input type="number" step="any" data-a="${i}" value="${Number(a[i]).toFixed(3)}">`).join('')}</span>
    </div>
    <p class="muted small">.setinsertionpoint side group x y z rx ry rz — side 0 and 1 are the two teams. Y rotation looks like radians (inferred from the values).</p>
    <div class="row"><button id="spCopy" title="Ctrl+D, or right-click → Duplicate">Duplicate spawn</button><button id="spDel">Delete spawn</button></div>`;
    this.el.querySelectorAll('[data-a]').forEach((inp) => inp.addEventListener('change', () => {
      const i = Number(inp.dataset.a);
      this.app.editSpawn(c, () => { c.args[i] = i < 2 ? String(parseInt(inp.value, 10) || 0) : fmt(Number(inp.value)); });
    }));
    this.el.querySelector('#spCopy').addEventListener('click', () => this.app.duplicateSelection());
    this.el.querySelector('#spDel').addEventListener('click', () => this.app.deleteSelection());
  }
}
