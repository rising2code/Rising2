// Level 3: "Export level…" writes a complete level folder and rebuilds the files that
// depend on the edits. Moving objects only changes numbers in the .n2; everything that is
// derived from the level is handled here:
//   - level .n2 (with paths rewritten when the level gets a new name or place in the game)
//   - lightmap.mdat: baked lighting is looked up by object path, so copied / renamed objects
//     get the original's lighting and deleted objects are removed. Light is NOT re-baked:
//     a moved object keeps its old shading and leaves its old shadow on the ground.
//   - terrain: heightmap.bmp, .setminheight/.setmaxheight; the precomputed terrain mesh no
//     longer matches, so ".setfixterrain false" asks the engine to build the terrain itself
//     (inferred from the exe, not yet tested in game)
//   - minimaps (level_map.dds, level_map_menu.dds) rendered from a textured top view of the
//     square .setmapoffset x z .. + terrainSize * scale (inferred from the Eiffel minimap)
//   - menu picture <level>.dds from the current camera
//   - <level>.dat menu texts, .tai atlas indexes and .flsproj with the new paths

import { writeN2 } from '../lib/n2.js';
import { encodeHeightmap, parseLightmapMdat, writeLightmapMdat, lightmapKey, encodeLevelDat } from '../lib/levelfiles.js';
import { encodeDds } from '../lib/dds.js';
import { join, basename } from './level.js';
import { esc } from './tree.js';
import { fmt } from '../lib/n2.js';

// Every step of the export, in the order it runs. The dialog shows one switch per step
// with a fold-out explanation; `state(ctx)` can lock a step on or disable it with a reason.
const STEPS = [
  {
    id: 'copy', title: 'Copy the level folder', on: true,
    detail: 'Copies everything in the level folder (textures, grass, missions, lightmap pictures…) to the output folder, so the result is a complete level. Off: only the files of the steps below are written.',
    state: (c) => (c.sameDir ? { off: 'The output is the level\'s own folder: nothing to copy.' } : null),
  },
  {
    id: 'rename', title: 'Rename the level\'s own files', on: true,
    detail: 'With a new level name, the copied <old>.dat, <old>.dds, <old>.bin and <old>.flsproj become <new>.*, because the game finds them by the level\'s name.',
    state: (c) => (!c.nameChanged ? { off: 'The name is unchanged.' } : !c.copy ? { off: 'Needs "Copy the level folder".' } : { locked: 'Needed for the new name.' }),
  },
  {
    id: 'terrain', title: 'Write the edited terrain', on: true,
    detail: 'Writes heightmap.bmp with your brush edits (each height packed into the pixel colours as metres + hundredths + ten-thousandths) and updates .setminheight / .setmaxheight. The level\'s ready-made terrain mesh no longer matches the heights, so .setfixterrain false asks the game to build the terrain from the heightmap itself — worked out from the game code, not yet tested in game.',
    state: (c) => (!c.terrainDirty ? { off: 'The terrain was not edited.' } : null),
  },
  {
    id: 'script', title: 'Write the level script (.n2)', on: true,
    detail: 'The same text as "Save .n2": the object tree with every position, rotation, scale and property, the spawn points and level settings. With a new name or location, every path inside it (home:data/levels/…/old/ → …/new/: heightmap, missions, level path) is rewritten.',
    state: () => ({ locked: 'Always: it holds your edits.' }),
  },
  {
    id: 'lightmap', title: 'Carry baked lighting over (lightmap.mdat)', on: true,
    detail: 'The game finds each object\'s baked shading by a checksum of its name and place in the object tree. Copied or pasted objects (same level) get their original\'s lighting, renamed objects keep theirs under the new name, deleted objects lose theirs. Moved objects keep their entry as it is: their old light and shadow stay (see "Re-bake lighting" below).',
    state: (c) => (!c.hasMdat ? { off: 'This level has no maps\lightmap.mdat.' } : null),
  },
  {
    id: 'texts', title: 'Update menu texts and atlas indexes', on: true,
    detail: 'Writes <level>.dat (the name and briefings from the Level info tab) and, with a new name or location, rewrites the paths in static.tai, maps\speedgrass.tai (which textures sit in which atlas picture) and the .flsproj project file.',
    state: (c) => (!c.datDirty && !c.nameChanged && !c.pathChanged ? { off: 'Name, location and menu texts are unchanged.' } : null),
  },
  {
    id: 'bin', title: 'Remove the render cache (<level>.bin)', on: true,
    detail: 'A small cache with counts of the level\'s objects. After adding or removing objects those counts no longer match, so it is deleted. The file is not fully understood and the game\'s behaviour without it is untested.',
    state: (c) => (!c.structureChanged ? { off: 'No objects were added or removed.' } : !c.copy && !c.sameDir ? { off: 'Needs "Copy the level folder".' } : null),
  },
  {
    id: 'minimap', title: 'Render new minimaps', on: false,
    detail: 'Renders level_map.dds (2048 px) and level_map_menu.dds (1024 px) from a textured top view of exactly the area the game\'s minimap covers (.setmapoffset x z, terrain size × scale). The originals also show grass and tree tops, so the new ones look less green. The side minimaps with attack arrows are not touched (see below).',
  },
  {
    id: 'thumb', title: 'Render the menu picture from the current camera', on: false,
    detail: 'Renders <level>.dds, the 512 × 512 picture in the level menu, from where the camera is now. Place the camera before exporting.',
  },
  {
    id: 'install', title: 'Show how to install it', on: true,
    detail: 'The log ends with where the folder must go inside the game and the line to add to gameserver.tcl so the game lists the level. The editor does not change that file itself.',
    state: () => ({ locked: 'Always.' }),
  },
];

const UNSUPPORTED = [
  { title: 'Re-bake lighting and shadows', detail: 'Moved objects keep their old light and shadow, and their old shadow stays on the ground where they were. Re-baking would need a light simulator that writes new lightmap pictures and lightmap.mdat.' },
  { title: 'Update the grass (grass.dat)', detail: 'Grass under a moved building stays where it was, and there is no grass on newly raised terrain.' },
  { title: 'Rebuild the ready-made terrain mesh', detail: 'terrain\meshes\terrainmesh.nvx2 is left as it is. With an edited terrain the game is asked to build its own instead (see "Write the edited terrain").' },
  { title: 'Update the ground material map (terrainmat.bin)', detail: 'The map that picks footstep and impact sounds per spot of ground keeps its old layout.' },
  { title: 'Update the mission files', detail: 'missions\*.n2 (game modes, objectives) are copied unchanged.' },
  { title: 'Re-render the side minimaps', detail: 'level_map_efn.dds and level_map_usmc.dds carry hand-drawn attack arrows and are left as they are.' },
  { title: 'Register the level in gameserver.tcl', detail: 'The editor writes only into the output folder. The export log shows the line to add yourself.' },
];

export class ExportDialog {
  constructor(app) {
    this.app = app;
    this.dlg = document.getElementById('exportDialog');
    this.log = document.getElementById('expLog');
    document.getElementById('expPick').addEventListener('click', async () => {
      const d = await window.api.openFolder({ title: 'Output folder' });
      if (d) {
        document.getElementById('expDir').value = d;
        this.guessGamePath();
      }
    });
    document.getElementById('expDir').addEventListener('change', () => { this.guessGamePath(); this.refresh(); });
    document.getElementById('expGamePath').addEventListener('input', () => this.refresh());
    document.getElementById('expName').addEventListener('input', () => {
      // the level's folder inside the game is named after the level: keep the two in step
      const gp = document.getElementById('expGamePath');
      const name = document.getElementById('expName').value.trim();
      const parts = gp.value.split('/');
      if (name && parts[parts.length - 1] === this.lastName) { parts[parts.length - 1] = name; gp.value = parts.join('/'); }
      this.lastName = name;
      this.refresh();
    });
    document.getElementById('expName').addEventListener('change', () => { this.guessGamePath(); this.refresh(); });
    this.renderSteps();
    document.getElementById('expRun').addEventListener('click', () => this.run().catch((e) => this.write('ERROR: ' + e.message)));
  }

  async open() {
    const lv = this.app.level;
    if (!lv) return;
    const appDir = await window.api.appDir();
    document.getElementById('expDir').value = join(appDir, 'output', lv.name);
    document.getElementById('expName').value = lv.name;
    document.getElementById('expGamePath').value = lv.gameRel;
    this.lastName = lv.name;
    this.hasMdat = await window.api.exists(join(lv.dir, 'maps', 'lightmap.mdat'));
    for (const st of STEPS) this.wanted[st.id] = st.on; // back to the defaults each time
    this.refresh();
    this.log.textContent = '';
    this.dlg.showModal();
  }

  /** Builds the rows: switch, title, note, ▸ button and the fold-out explanation. */
  renderSteps() {
    this.wanted = Object.fromEntries(STEPS.map((s) => [s.id, s.on])); // what the user chose
    const row = (cls, i, title, detail, data) => `
      <div class="step ${cls}" data-${data}="${i}">
        <label class="switch" title="${cls === 'unsupported' ? 'Not supported yet' : 'Switch this step on or off'}">
          <input type="checkbox" data-${data}="${i}"><span class="slider"></span></label>
        <span class="stitle">${esc(title)}</span>
        <span class="snote"></span>
        <button type="button" class="expand" aria-expanded="false" title="What does this step do?">▸</button>
        <div class="sdetail" hidden>${esc(detail)}</div>
      </div>`;
    const stepsEl = document.getElementById('expSteps');
    const unEl = document.getElementById('expUnsupported');
    stepsEl.innerHTML = STEPS.map((s, i) => row('', i, s.title, s.detail, 'step')).join('');
    unEl.innerHTML = UNSUPPORTED.map((s, i) => row('unsupported', i, s.title, s.detail, 'un')).join('');
    for (const el of [stepsEl, unEl]) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('.expand');
        if (!b) return;
        const d = b.parentElement.querySelector('.sdetail');
        d.hidden = !d.hidden;
        b.textContent = d.hidden ? '▸' : '▾';
        b.setAttribute('aria-expanded', String(!d.hidden));
      });
    }
    stepsEl.addEventListener('change', (e) => {
      const i = e.target.dataset.step;
      if (i === undefined) return;
      this.wanted[STEPS[i].id] = e.target.checked;
      this.refresh();
    });
    unEl.addEventListener('change', (e) => {
      // unsupported steps cannot be switched on: flip back and say why
      const i = e.target.dataset.un;
      if (i === undefined) return;
      e.target.checked = false;
      const rowEl = e.target.closest('.step');
      rowEl.querySelector('.snote').textContent = 'Not supported yet';
      rowEl.querySelector('.sdetail').hidden = false;
      rowEl.querySelector('.expand').textContent = '▾';
      rowEl.classList.remove('shake');
      void rowEl.offsetWidth;
      rowEl.classList.add('shake');
    });
  }

  /** Facts the steps depend on, from the level and the dialog's fields. */
  context() {
    const lv = this.app.level;
    const outDir = document.getElementById('expDir').value.replace(/[\\/]+$/, '');
    const name = document.getElementById('expName').value.trim() || lv.name;
    const gamePath = document.getElementById('expGamePath').value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return {
      sameDir: outDir.toLowerCase() === lv.dir.toLowerCase(),
      nameChanged: name !== lv.name,
      pathChanged: gamePath !== lv.gameRel,
      terrainDirty: !!lv.terrainDirty,
      structureChanged: !!lv.structureChanged,
      datDirty: !!lv.datDirty && lv.datText !== null,
      hasMdat: this.hasMdat,
      copy: false,
    };
  }

  /** Applies locks and "not needed" states, and returns which steps will run. */
  refresh() {
    if (!this.app.level) return {};
    const c = this.context();
    const on = {};
    STEPS.forEach((s, i) => {
      c.copy = on.copy; // later steps can depend on the copy step
      const st = s.state ? s.state(c) : null;
      const input = document.querySelector(`#expSteps input[data-step="${i}"]`);
      const rowEl = input.closest('.step');
      if (st && st.locked) { input.checked = true; input.disabled = true; on[s.id] = true; }
      else if (st && st.off) { input.checked = false; input.disabled = true; on[s.id] = false; }
      else { input.disabled = false; input.checked = this.wanted[s.id]; on[s.id] = this.wanted[s.id]; }
      rowEl.classList.toggle('disabled', !!(st && st.off));
      rowEl.querySelector('.snote').textContent = st ? st.locked || st.off : '';
    });
    this.on = on;
    return on;
  }

  /** If the output folder is inside the game's data\levels, the game path follows it. */
  guessGamePath() {
    const lv = this.app.level;
    const dir = document.getElementById('expDir').value.replace(/[\\/]+$/, '');
    if (dir.toLowerCase().startsWith(lv.home.toLowerCase() + '\\data\\levels\\')) {
      document.getElementById('expGamePath').value = dir.slice(lv.home.length + 1).replace(/\\/g, '/');
      document.getElementById('expName').value = basename(dir);
    }
  }

  write(s) {
    this.log.textContent += s + '\n';
    this.log.scrollTop = this.log.scrollHeight;
  }

  async run() {
    const app = this.app, lv = app.level, vp = app.viewport;
    const outDir = document.getElementById('expDir').value.replace(/[\\/]+$/, '');
    const name = document.getElementById('expName').value.trim() || lv.name;
    const gamePath = document.getElementById('expGamePath').value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const on = this.refresh(); // the switches as shown
    this.log.textContent = '';

    if (outDir.toLowerCase() === lv.dir.toLowerCase()) {
      const ok = await window.api.confirm('Export into the level\'s own folder?', 'This overwrites the original level files. Keep a backup of the folder first.');
      if (!ok) return;
    }
    const oldRel = lv.gameRel, oldName = lv.name;
    const oldLevels = oldRel.replace(/^data\/levels\//i, ''), newLevels = gamePath.replace(/^data\/levels\//i, '');
    const fixPaths = (s) => {
      if (gamePath === oldRel && name === oldName) return s;
      let r = s.split(`home:${oldRel}/`).join(`home:${gamePath}/`).split(`levels:${oldLevels}/`).join(`levels:${newLevels}/`);
      // the level's own menu picture, e.g. "[Image]levels:france/eiffel/eiffel.dds"
      r = r.split(`levels:${newLevels}/${oldName}.dds`).join(`levels:${newLevels}/${name}.dds`);
      r = r.split(`home:${gamePath}/${oldName}.dds`).join(`home:${gamePath}/${name}.dds`);
      return r;
    };
    const renameFile = (f) => (f.replace(/\.[^.]+$/, '') === oldName ? name + f.slice(oldName.length) : f);

    // 1. copy everything else first, so the rebuilt files overwrite the copies
    if (on.copy) {
      await window.api.copyDir(lv.dir, outDir);
      this.write(`Copied ${lv.dir} -> ${outDir}`);
      if (on.rename) {
        for (const f of await window.api.list(outDir)) {
          if (f.dir || renameFile(f.name) === f.name) continue;
          await window.api.writeFile(join(outDir, renameFile(f.name)), await window.api.readBinary(join(outDir, f.name)));
          await window.api.remove(join(outDir, f.name));
          this.write(`Renamed ${f.name} -> ${renameFile(f.name)}`);
        }
      }
    }

    // 2. terrain
    if (on.terrain && lv.terrain && lv.terrainNode) {
      const t = lv.terrain;
      const enc = encodeHeightmap(t.heights, t.width, t.height);
      await window.api.writeFile(join(outDir, 'terrain', 'textures', 'heightmap.bmp'), enc.bytes);
      lv.terrainNode.setCmd('setminheight', [fmt(enc.minHeight)]);
      lv.terrainNode.setCmd('setmaxheight', [fmt(enc.maxHeight)]);
      lv.terrainNode.setCmd('setfixterrain', ['false']);
      this.write(`Wrote heightmap.bmp (heights ${enc.minHeight.toFixed(3)} .. ${enc.maxHeight.toFixed(3)} m), set .setfixterrain false so the engine rebuilds the terrain mesh (untested in game).`);
    }

    // 3. level script
    const n2Text = fixPaths(writeN2(lv.doc));
    await window.api.writeFile(join(outDir, name + '.n2'), n2Text);
    this.write(`Wrote ${name}.n2`);

    // 4. lightmap records
    const mdatSrc = join(lv.dir, 'maps', 'lightmap.mdat');
    if (on.lightmap && (await window.api.exists(mdatSrc))) {
      const recs = parseLightmapMdat(await window.api.readBinary(mdatSrc));
      const origKeys = new Set();
      for (const p of lv.origPaths) origKeys.add(lightmapKey(p));
      const out = new Map();
      for (const [k, r] of recs) if (!origKeys.has(k)) out.set(k, r); // records we can't place: keep
      let carried = 0, moved = 0;
      for (const n of lv.root.walk()) {
        if (!n.parent || !n.origPath) continue;
        const r = recs.get(lightmapKey(n.origPath));
        if (!r) continue;
        out.set(lightmapKey(n.path()), { atlas: fixPaths(r.atlas), uv: r.uv });
        carried++;
        if (n.path() !== n.origPath) moved++;
      }
      for (const [k, r] of out) out.set(k, { atlas: fixPaths(r.atlas), uv: r.uv }); // kept records too
      await window.api.writeFile(join(outDir, 'maps', 'lightmap.mdat'), writeLightmapMdat(out));
      this.write(`Wrote maps/lightmap.mdat: ${out.size} records (was ${recs.size}); ${moved} copied or renamed parts reuse their original's baked lighting. Moved objects keep their old shading (no light re-bake).`);
    }

    // 5. menu texts, atlas indexes, editor project
    if (on.texts && lv.datText !== null) {
      await window.api.writeFile(join(outDir, name + '.dat'), encodeLevelDat(fixPaths(lv.datText)));
      this.write(`Wrote ${name}.dat`);
    }
    if (on.texts && (gamePath !== oldRel || name !== oldName)) {
      for (const rel of ['static.tai', 'maps\\speedgrass.tai', name + '.flsproj']) {
        const p = join(outDir, rel);
        if (!(await window.api.exists(p))) continue;
        await window.api.writeFile(p, fixPaths(await window.api.readText(p)));
        this.write(`Updated paths in ${rel}`);
      }
    }

    // 6. render cache
    if (on.bin && (await window.api.exists(join(outDir, name + '.bin')))) {
      await window.api.remove(join(outDir, name + '.bin'));
      this.write(`Removed ${name}.bin (render cache; objects were added or removed — its effect is not fully understood)`);
    }

    // 7. pictures
    if (on.minimap) {
      const mo = lv.root.nums('setmapoffset') || [0, 0, 1];
      const size = (lv.terrain ? lv.terrain.size : 1024) * mo[2];
      this.write(`Rendering minimap of x ${mo[0]}..${mo[0] + size}, z ${mo[1]}..${mo[1] + size} ...`);
      const rgba = await vp.renderTopView(mo[0], mo[1], size, 2048);
      await window.api.writeFile(join(outDir, 'level_map.dds'), encodeDds(rgba, 2048, 2048, 'DXT1', true));
      const small = downscale(rgba, 2048, 1024);
      await window.api.writeFile(join(outDir, 'level_map_menu.dds'), encodeDds(small, 1024, 1024, 'DXT1', false));
      this.write('Wrote level_map.dds and level_map_menu.dds (level_map_efn/usmc with the attack arrows were left as they are).');
    }
    if (on.thumb) {
      const rgba = await vp.renderFromCamera(512);
      await window.api.writeFile(join(outDir, name + '.dds'), encodeDds(rgba, 512, 512, 'DXT5', false));
      this.write(`Wrote ${name}.dds (menu picture)`);
    }

    this.write('');
    this.write('Done. To play it, the folder must be at  <game>\\' + gamePath.replace(/\//g, '\\'));
    this.write(`and registered in gameserver.tcl, e.g.:  .addlevel <n> "home:${gamePath}/${name}.n2"`);
    app.status('Exported to ' + outDir);
  }
}

function downscale(rgba, w, nw) {
  const f = w / nw;
  const out = new Uint8ClampedArray(nw * nw * 4);
  for (let y = 0; y < nw; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += rgba[((y * f + dy) * w + x * f + dx) * 4 + c];
    out[(y * nw + x) * 4 + c] = s / (f * f);
  }
  return out;
}
