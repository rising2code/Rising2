// A loaded level: its folder, the parsed .n2 tree, the terrain heights, and how
// Nebula "assign" paths (meshes:, textures:, home: ...) map to files on disk.

import { parseN2 } from '../lib/n2.js';
import { decodeHeightmap, decodeLevelDat } from '../lib/levelfiles.js';
import { parseMesh } from '../lib/mesh.js';
import { decodeDds } from '../lib/dds.js';

const api = window.api;

export const join = (...p) => p.join('\\').replace(/[\\/]+/g, '\\');
export const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
export const dirname = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join('\\');

/** Finds the game root ("home:"), i.e. the folder that contains data\levels. */
async function findHome(levelDir) {
  let d = levelDir;
  for (let i = 0; i < 8 && d; i++) {
    if (await api.exists(join(d, 'data', 'levels'))) return d;
    d = dirname(d);
  }
  return null;
}

export class Level {
  static async open(dir) {
    const lv = new Level();
    lv.dir = dir.replace(/[\\/]+$/, '');
    lv.name = basename(lv.dir);
    lv.home = await findHome(lv.dir);
    if (!lv.home) throw new Error('Could not find the game folder (a folder containing data\\levels) above ' + dir);

    lv.n2Path = join(lv.dir, lv.name + '.n2');
    if (!(await api.exists(lv.n2Path))) {
      const files = (await api.list(lv.dir)).filter((f) => !f.dir && /\.n2$/i.test(f.name));
      let found = null;
      for (const f of files) {
        const head = (await api.readText(join(lv.dir, f.name))).slice(0, 400);
        if (head.includes('$class:nlevelnode$')) { found = f.name; break; }
      }
      if (!found) throw new Error('No level script (.n2 with class nlevelnode) in ' + dir);
      lv.n2Path = join(lv.dir, found);
      lv.name = found.replace(/\.n2$/i, '');
    }
    lv.doc = parseN2(await api.readText(lv.n2Path));
    lv.root = lv.doc.root;
    lv.origPaths = [...lv.root.walk()].filter((n) => n.parent).map((n) => n.origPath);
    lv.entities = lv.root.child('entities') || lv.root;
    lv.terrainNode = lv.root.children.find((c) => c.cls === 'terrainnode') || null;
    // where the level lives inside the game, e.g. "data/levels/france/eiffel"
    lv.gameRel = lv.dir.slice(lv.home.length + 1).replace(/\\/g, '/');
    lv.terrain = null;
    lv.terrainDirty = false;
    if (lv.terrainNode) await lv.loadTerrain();
    const datPath = join(lv.dir, lv.name + '.dat');
    lv.datText = (await api.exists(datPath)) ? decodeLevelDat(await api.readBinary(datPath)) : null;
    lv.datDirty = false;
    lv.structureChanged = false;
    return lv;
  }

  async loadTerrain() {
    const t = this.terrainNode;
    const num = (n, d) => (t.cmd(n) ? Number(t.cmd(n).args[0]) : d);
    const size = num('setsize', 1024);
    const resolution = num('setresolution', 512);
    const minH = num('setminheight', 0);
    const hmCmd = t.cmd('setheightmap');
    const file = hmCmd ? this.resolve(hmCmd.args[0]) : join(this.dir, 'terrain', 'textures', 'heightmap.bmp');
    if (!(await api.exists(file))) return;
    const hm = decodeHeightmap(await api.readBinary(file), minH);
    this.terrain = { ...hm, size, resolution, spacing: size / resolution, file };
  }

  /** Height of the terrain at world (x, z), bilinear. */
  heightAt(x, z) {
    const t = this.terrain;
    if (!t) return 0;
    const fx = Math.min(Math.max(x / t.spacing, 0), t.width - 1.0001);
    const fz = Math.min(Math.max(z / t.spacing, 0), t.height - 1.0001);
    const x0 = Math.floor(fx), z0 = Math.floor(fz), dx = fx - x0, dz = fz - z0;
    const h = (i, j) => t.heights[j * t.width + i];
    return (h(x0, z0) * (1 - dx) + h(x0 + 1, z0) * dx) * (1 - dz) + (h(x0, z0 + 1) * (1 - dx) + h(x0 + 1, z0 + 1) * dx) * dz;
  }

  /** Maps a Nebula path ("meshes:x.nvx2", "home:data/...") to a Windows path. */
  resolve(p) {
    p = p.replace(/^"|"$/g, '');
    const m = p.match(/^([a-z0-9_]+):(.*)$/i);
    if (!m) return join(this.dir, p);
    const [, assign, rest] = m;
    const map = {
      home: '', meshes: 'data\\meshes', textures: 'data\\textures', levels: 'data\\levels',
      atlastextures: 'data\\atlastextures', entities: 'data\\entities', common: 'common',
      speedtree: 'data\\speedtree', anims: 'data\\animations', physics: 'data\\physics',
      shaders: 'common\\shaders\\2.0', soundfiles: 'data\\sfx',
    };
    const base = map[assign.toLowerCase()];
    if (base === undefined) return join(this.home, rest);
    return join(this.home, base, rest);
  }

  /** Inverse of resolve() for textures, preferring "textures:". */
  toAssign(winPath) {
    const rel = winPath.slice(this.home.length + 1).replace(/\\/g, '/');
    if (rel.toLowerCase().startsWith('data/textures/')) return 'textures:' + rel.slice('data/textures/'.length);
    if (rel.toLowerCase().startsWith('data/levels/')) return 'levels:' + rel.slice('data/levels/'.length);
    if (rel.toLowerCase().startsWith('common/')) return 'common:' + rel.slice('common/'.length);
    return 'home:' + rel;
  }
}

// ---------- shared asset caches ----------

const meshCache = new Map();
export function loadMesh(level, assignPath) {
  const file = level.resolve(assignPath);
  if (!meshCache.has(file)) {
    meshCache.set(file, api.readBinary(file).then((b) => parseMesh(file, b)).catch((e) => {
      console.warn('mesh', file, e);
      return null;
    }));
  }
  return meshCache.get(file);
}

const texCache = new Map();
export function loadDds(file) {
  if (!texCache.has(file)) {
    texCache.set(file, api.readBinary(file).then((b) => decodeDds(b)).catch((e) => {
      console.warn('texture', file, e);
      return null;
    }));
  }
  return texCache.get(file);
}

export function clearCaches() {
  meshCache.clear();
  texCache.clear();
}
