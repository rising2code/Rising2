// Prefab library: the game's own entity templates (data/entities/**/*.n2, the same files
// the original editor listed under [Entities] in the .flsproj) plus your own prefabs saved
// from the editor into <editor>/prefabs. Both use the same format: the body of one node.

import { nodeFromTemplate, templateFromNode } from '../lib/n2.js';
import { esc } from './tree.js';
import { join, basename } from './level.js';

export class PrefabPanel {
  constructor(listEl, filterEl, app) {
    this.listEl = listEl;
    this.filterEl = filterEl;
    this.app = app;
    this.items = [];
    filterEl.addEventListener('input', () => this.render());
    listEl.addEventListener('dblclick', (e) => this.onPick(e));
    listEl.addEventListener('click', (e) => {
      const it = e.target.closest('.pitem');
      if (it) this.app.status(`Double-click to place "${this.items[Number(it.dataset.i)].name}" at the centre of the view.`);
    });
  }

  async load(level) {
    const appDir = await window.api.appDir();
    this.userDir = join(appDir, 'prefabs');
    const user = (await window.api.exists(this.userDir)) ? await window.api.listRecursive(this.userDir, ['.n2']) : [];
    const entDir = join(level.home, 'data', 'entities');
    const game = (await window.api.listRecursive(entDir, ['.n2'])).filter((p) => !/[\\/]pack[\\/]/i.test(p));
    this.items = [
      ...user.map((p) => ({ path: p, name: basename(p).replace(/\.n2$/i, ''), src: 'my prefabs', rel: p.slice(this.userDir.length + 1) })),
      ...game.map((p) => ({ path: p, name: basename(p).replace(/\.n2$/i, ''), src: 'game', rel: p.slice(entDir.length + 1) })),
    ];
    this.render();
  }

  render() {
    const f = this.filterEl.value.trim().toLowerCase();
    let html = '';
    let group = null;
    this.items.forEach((it, i) => {
      if (f && !it.rel.toLowerCase().includes(f)) return;
      if (it.src !== group) { group = it.src; html += `<div class="pgroup">${group === 'game' ? 'Game entity templates' : 'My prefabs'}</div>`; }
      const folder = it.rel.includes('\\') ? it.rel.slice(0, it.rel.lastIndexOf('\\')) : '';
      html += `<div class="pitem" data-i="${i}" title="${esc(it.path)}">${esc(it.name)} <span class="src">${esc(folder)}</span></div>`;
    });
    this.listEl.innerHTML = html || '<p class="muted" style="padding:8px">Nothing found.</p>';
  }

  async onPick(e) {
    const el = e.target.closest('.pitem');
    if (!el) return;
    const it = this.items[Number(el.dataset.i)];
    const text = await window.api.readText(it.path);
    if (!text.includes('$class:')) { this.app.status(`${it.name}: not a single-entity template.`); return; }
    this.app.placeTemplate(text, it.name);
  }

  async saveSelected(node) {
    const file = await window.api.saveFile({
      title: 'Save prefab',
      defaultPath: join(this.userDir, node.name.replace(/\?\d+$/, '') + '.n2'),
      filters: [{ name: 'Nebula script', extensions: ['n2'] }],
    });
    if (!file) return;
    await window.api.writeFile(file, templateFromNode(node));
    this.app.status(`Saved prefab ${file}`);
    await this.load(this.app.level);
  }
}

export { nodeFromTemplate };
