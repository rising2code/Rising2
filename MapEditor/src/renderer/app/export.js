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
    id: 'refs', title: 'Point to the original level\'s big textures instead of copying them', on: false,
    detail: 'For a variant of a level every player already has (e.g. eiffel → eiffel_night). The baked-lighting pictures (maps\\lightmap0..3.dds), the object atlases (maps\\atl*.dds) and the grass atlas (maps\\speedgrass*.dds) are not copied; lightmap.mdat, static.tai and speedgrass.tai point to them in the original folder (home:…/eiffel/maps/…). For Eiffel that is 31 of 71 MB. Files the game finds by name inside the level\'s own folder must still be copied: grass.dat, the terrain folder, the minimaps, lightmap.mdat and the atl*_nl.dds atlases. Object models and textures (data\\meshes, data\\textures) are never copied anyway. The original level must stay installed. Pointing static.tai into another level\'s folder is not yet tested in game.',
    state: (c) => (!c.copy ? { off: 'Needs "Copy the level folder".' }
      : !c.pathChanged ? { off: 'The level keeps its own place in the game, so it would point to itself. Give it a new name or game path.' } : null),
  },
  {
    id: 'nograss', title: 'Leave the grass out (empty grass.dat)', on: false,
    detail: 'grass.dat is a text list with one line per grass clump ("b x z size …"); Eiffel has 348,000 of them (12.6 MB). The game finds it by name in the level\'s own folder, so it cannot point to another level\'s copy. With this on, the export writes a grass.dat with the same header and texture but no clumps (about 100 bytes): the level has no grass. Not yet tested in game.',
    state: (c) => (c.sameDir ? { off: 'Would delete the original level\'s grass.' } : !c.hasGrass ? { off: 'This level has no grass.dat.' } : null),
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
    this.hasGrass = await window.api.exists(join(lv.dir, 'grass.dat'));
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
      hasGrass: this.hasGrass,
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

  /**
   * Textures in the level's maps folder that the game reaches through a full path written in
   * a file (so they can stay in the original folder): the baked-lighting pictures named in
   * lightmap.mdat, the grass atlas named in speedgrass.tai and the object atlases named in
   * static.tai. Returned relative to the level folder, e.g. "maps\lightmap0.dds".
   */
  async referencedTextures() {
    const lv = this.app.level, api = window.api;
    const names = new Set();
    const mdat = join(lv.dir, 'maps', 'lightmap.mdat');
    if (await api.exists(mdat)) for (const r of parseLightmapMdat(await api.readBinary(mdat)).values()) names.add(basename(r.atlas.replace(/\//g, '\\')));
    const sg = join(lv.dir, 'maps', 'speedgrass.tai');
    if (await api.exists(sg)) for (const m of (await api.readText(sg)).matchAll(/"[^"]*\/maps\/([^"/]+\.dds)"/gi)) names.add(m[1]);
    const st = join(lv.dir, 'static.tai');
    if (await api.exists(st)) for (const m of (await api.readText(st)).matchAll(/"(?:atlastextures:|[^"]*\/maps\/)([^"/]+\.dds)"/gi)) names.add(m[1]);
    const out = [];
    for (const n of names) if (await api.exists(join(lv.dir, 'maps', n))) out.push('maps\\' + n);
    return out;
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

    // big textures that can stay in the original folder: the game reaches them through full
    // paths in lightmap.mdat, static.tai and speedgrass.tai, not by looking in the level folder
    const refs = on.refs ? await this.referencedTextures() : [];
    if (on.nograss) refs.push('grass.dat'); // written empty below instead of copied
    const refSet = new Set(refs.map((f) => f.toLowerCase()));
    const origMaps = `home:${oldRel}/maps/`;
    // paths that must keep pointing to the original folder in reference mode
    const keepRef = (s) => on.refs && refSet.has(('maps\\' + s.slice(s.lastIndexOf('/') + 1)).toLowerCase())
      && /\/maps\/[^/]+$/i.test(s);

    // 1. copy everything else first, so the rebuilt files overwrite the copies
    if (on.copy) {
      const r = await window.api.copyDir(lv.dir, outDir, refs);
      this.write(`Copied ${lv.dir} -> ${outDir}`);
      if (on.refs) {
        this.write(`  not copied: ${r.skipped - (on.nograss ? 1 : 0)} textures — the level points to them in ${origMaps}`);
        // static.tai names the object atlases as "atlastextures:atl200.dds", which the game reads
        // from the level's own maps folder: point those at the original folder instead
        const tai = join(outDir, 'static.tai');
        if (await window.api.exists(tai)) {
          let n = 0;
          const t = (await window.api.readText(tai)).replace(/"atlastextures:([^"]+)"/gi, (m, f) => {
            if (!refSet.has(('maps\\' + f.replace(/\//g, '\\')).toLowerCase())) return m;
            n++;
            return `"${origMaps}${f}"`;
          });
          await window.api.writeFile(tai, t);
          this.write(`  static.tai: ${n} atlas entries now point to ${origMaps}`);
        }
      }
      if (on.rename) {
        for (const f of await window.api.list(outDir)) {
          if (f.dir || renameFile(f.name) === f.name) continue;
          await window.api.writeFile(join(outDir, renameFile(f.name)), await window.api.readBinary(join(outDir, f.name)));
          await window.api.remove(join(outDir, f.name));
          this.write(`Renamed ${f.name} -> ${renameFile(f.name)}`);
        }
      }
    }

    // grass: same header and first texture as the original, no clumps
    if (on.nograss) {
      const src = await window.api.readText(join(lv.dir, 'grass.dat'));
      const lines = src.slice(0, 4096).split(/\r?\n/);
      const data = (lines[1] || '').split(' ');
      const tex = lines.find((l) => /^textures:/i.test(l)) || 'textures:speedgrass/Grass_10_dry.dds';
      const out = ['type speedgrass', `Data 1 ${data[2] || 1024} ${data[3] || 80}`, tex, 'Layer 1', tex, ''].join('\r\n');
      await window.api.writeFile(join(outDir, 'grass.dat'), out);
      this.write(`Wrote an empty grass.dat (${out.length} bytes instead of ${(src.length / 1048576).toFixed(1)} MB): no grass in this level.`);
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
        out.set(lightmapKey(n.path()), { atlas: r.atlas, uv: r.uv }); // paths are fixed below
        carried++;
        if (n.path() !== n.origPath) moved++;
      }
      for (const [k, r] of out) out.set(k, { atlas: keepRef(r.atlas) ? r.atlas : fixPaths(r.atlas), uv: r.uv }); // kept records too
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
        // quoted path by quoted path, so references to the original level's textures stay
        const src = await window.api.readText(p);
        const t = rel.endsWith('.tai') ? src.replace(/"([^"]*)"/g, (m, s) => (keepRef(s) ? m : `"${fixPaths(s)}"`)) : fixPaths(src);
        await window.api.writeFile(p, t);
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
