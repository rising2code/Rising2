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
import { fmt } from '../lib/n2.js';

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
    document.getElementById('expDir').addEventListener('change', () => this.guessGamePath());
    document.getElementById('expName').addEventListener('change', () => this.guessGamePath());
    document.getElementById('expRun').addEventListener('click', () => this.run().catch((e) => this.write('ERROR: ' + e.message)));
  }

  async open() {
    const lv = this.app.level;
    if (!lv) return;
    const appDir = await window.api.appDir();
    document.getElementById('expDir').value = join(appDir, 'output', lv.name);
    document.getElementById('expName').value = lv.name;
    document.getElementById('expGamePath').value = lv.gameRel;
    document.getElementById('expTerrain').disabled = !lv.terrainDirty;
    document.getElementById('expTerrain').parentElement.title = lv.terrainDirty ? '' : 'The terrain was not edited.';
    this.log.textContent = '';
    this.dlg.showModal();
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
    const opt = (id) => document.getElementById(id).checked && !document.getElementById(id).disabled;
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
    if (opt('expCopy') && outDir.toLowerCase() !== lv.dir.toLowerCase()) {
      await window.api.copyDir(lv.dir, outDir);
      this.write(`Copied ${lv.dir} -> ${outDir}`);
      if (name !== oldName) {
        for (const f of await window.api.list(outDir)) {
          if (f.dir || renameFile(f.name) === f.name) continue;
          await window.api.writeFile(join(outDir, renameFile(f.name)), await window.api.readBinary(join(outDir, f.name)));
          await window.api.remove(join(outDir, f.name));
          this.write(`Renamed ${f.name} -> ${renameFile(f.name)}`);
        }
      }
    }

    // 2. terrain
    if (opt('expTerrain') && lv.terrain && lv.terrainNode) {
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
    if (opt('expLightmap') && (await window.api.exists(mdatSrc))) {
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
    if (lv.datText !== null && (lv.datDirty || name !== oldName || gamePath !== oldRel)) {
      await window.api.writeFile(join(outDir, name + '.dat'), encodeLevelDat(fixPaths(lv.datText)));
      this.write(`Wrote ${name}.dat`);
    }
    if (gamePath !== oldRel || name !== oldName) {
      for (const rel of ['static.tai', 'maps\\speedgrass.tai', name + '.flsproj']) {
        const p = join(outDir, rel);
        if (!(await window.api.exists(p))) continue;
        await window.api.writeFile(p, fixPaths(await window.api.readText(p)));
        this.write(`Updated paths in ${rel}`);
      }
    }

    // 6. render cache
    if (opt('expBin') && lv.structureChanged && (await window.api.exists(join(outDir, name + '.bin')))) {
      await window.api.remove(join(outDir, name + '.bin'));
      this.write(`Removed ${name}.bin (render cache; objects were added or removed — its effect is not fully understood)`);
    }

    // 7. pictures
    if (opt('expMinimap')) {
      const mo = lv.root.nums('setmapoffset') || [0, 0, 1];
      const size = (lv.terrain ? lv.terrain.size : 1024) * mo[2];
      this.write(`Rendering minimap of x ${mo[0]}..${mo[0] + size}, z ${mo[1]}..${mo[1] + size} ...`);
      const rgba = await vp.renderTopView(mo[0], mo[1], size, 2048);
      await window.api.writeFile(join(outDir, 'level_map.dds'), encodeDds(rgba, 2048, 2048, 'DXT1', true));
      const small = downscale(rgba, 2048, 1024);
      await window.api.writeFile(join(outDir, 'level_map_menu.dds'), encodeDds(small, 1024, 1024, 'DXT1', false));
      this.write('Wrote level_map.dds and level_map_menu.dds (level_map_efn/usmc with the attack arrows were left as they are).');
    }
    if (opt('expThumb')) {
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
