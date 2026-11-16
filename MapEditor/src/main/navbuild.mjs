// Builds the bots' navigation map with Recast (WASM). Runs in a worker thread (nav-worker.mjs)
// and in tests. See docs/navmesh-assumptions.md for every number used here.
//
// Input: world-space triangles (game coordinates, metres, Y up) plus the hand edits.
// Output: polygons with an area type (walk / crouch / prone / avoid) and their neighbours,
// merged over all tiles into one plain list.

import {
  init, Raw, Recast, RecastBuildContext, VerticesArray, TrianglesArray, TriangleAreasArray, ChunkIdsArray,
  RecastChunkyTriMesh, createRcConfig, calcGridSize, allocHeightfield, createHeightfield,
  markWalkableTriangles, rasterizeTriangles, filterLowHangingWalkableObstacles, filterLedgeSpans,
  filterWalkableLowHeightSpans, allocCompactHeightfield, buildCompactHeightfield, erodeWalkableArea,
  markBoxArea, buildDistanceField, buildRegions, allocContourSet, buildContours, allocPolyMesh, buildPolyMesh,
  freeHeightfield, freeCompactHeightfield, freeContourSet, freePolyMesh,
} from '@recast-navigation/core';

/** Area ids inside Recast (0 = not walkable). Exported as names. */
export const AREA = { walk: 63, crouch: 2, prone: 3, avoid: 4 };
export const AREA_NAME = { 63: 'walk', 2: 'crouch', 3: 'prone', 4: 'avoid' };

export const DEFAULTS = {
  cs: 0.2,              // horizontal cell (m)
  ch: 0.05,             // vertical cell (m)
  radius: 0.4,          // soldier radius (m)
  heights: [1.8, 1.35, 0.8], // stand / crouch / prone (m)
  step: 0.15,           // virtual step (m)
  maxSlope: 45,         // degrees
  minIsland: 4,         // m²; smaller patches are dropped
  tileSize: 128,        // cells per tile side
};

let ready = null;
const ensureInit = () => (ready ||= init());

/**
 * @param {object} input
 *   positions Float32Array (x,y,z per vertex), indices Uint32Array (3 per triangle)
 *   bounds [[minx,miny,minz],[maxx,maxy,maxz]] (optional; default: the geometry's box)
 *   edits { avoid: [{min,max}], block: [{min,max}], walkable: [{min,max}] } (world boxes)
 * @param {(done:number,total:number)=>void} onProgress
 */
export async function buildNavmesh(input, onProgress = () => {}) {
  await ensureInit();
  const o = { ...DEFAULTS, ...(input.options || {}) };
  const { positions, indices } = input;
  const edits = { avoid: [], block: [], walkable: [], ...(input.edits || {}) };
  const t0 = Date.now();

  let bmin, bmax;
  if (input.bounds) [bmin, bmax] = input.bounds;
  else {
    bmin = [Infinity, Infinity, Infinity]; bmax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
      bmin[k] = Math.min(bmin[k], positions[i + k]); bmax[k] = Math.max(bmax[k], positions[i + k]);
    }
  }
  bmin = [...bmin]; bmax = [...bmax];
  bmax[1] += o.heights[0] + 1; // room above the highest floor

  const cell = (m) => Math.ceil(m / o.ch - 1e-6);
  const hStand = cell(o.heights[0]), hCrouch = cell(o.heights[1]), hProne = cell(o.heights[2]);
  const climb = Math.floor(o.step / o.ch + 1e-6);
  const radius = Math.ceil(o.radius / o.cs - 1e-6);
  const minSide = Math.round(Math.sqrt(o.minIsland) / o.cs);

  const cfg = createRcConfig({
    cs: o.cs, ch: o.ch, walkableSlopeAngle: o.maxSlope, walkableHeight: hProne, walkableClimb: climb,
    walkableRadius: radius, maxEdgeLen: 60, maxSimplificationError: 1.3, minRegionArea: minSide * minSide,
    mergeRegionArea: 400, maxVertsPerPoly: 6, tileSize: o.tileSize, detailSampleDist: 0, detailSampleMaxError: 1,
  });
  const border = radius + 3;
  cfg.borderSize = border;
  cfg.width = cfg.height = o.tileSize + border * 2;
  const grid = calcGridSize(bmin, bmax, o.cs);
  const tilesX = Math.ceil(grid.width / o.tileSize), tilesZ = Math.ceil(grid.height / o.tileSize);
  const tcs = o.tileSize * o.cs;

  const ctx = new RecastBuildContext();
  const verts = new VerticesArray(); verts.copy(positions);
  const tris = new TrianglesArray(); tris.copy(new Int32Array(indices.buffer, indices.byteOffset, indices.length));
  const nTris = indices.length / 3;
  const chunky = new RecastChunkyTriMesh();
  if (!chunky.init(verts, tris, nTris, 256)) throw new Error('Could not index the triangles');

  const M = Raw.Module;
  const out = new Merger(o);
  const chunkIds = new ChunkIdsArray(); chunkIds.resize(4096);
  const inBox = (b, x, y, z) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2];
  let built = 0;

  for (let tz = 0; tz < tilesZ; tz++) for (let tx = 0; tx < tilesX; tx++) {
    onProgress(tz * tilesX + tx, tilesX * tilesZ);
    const tmin = [bmin[0] + tx * tcs - border * o.cs, bmin[1], bmin[2] + tz * tcs - border * o.cs];
    const tmax = [bmin[0] + (tx + 1) * tcs + border * o.cs, bmax[1], bmin[2] + (tz + 1) * tcs + border * o.cs];
    const n = chunky.getChunksOverlappingRect([tmin[0], tmin[2]], [tmax[0], tmax[2]], chunkIds, 4096);
    if (!n) continue;
    const hf = allocHeightfield();
    createHeightfield(ctx, hf, cfg.width, cfg.height, tmin, tmax, o.cs, o.ch);
    for (let i = 0; i < n; i++) {
      const id = chunkIds.get(i);
      const node = chunky.nodes(id);
      const nodeTris = chunky.getNodeTris(id);
      const areas = new TriangleAreasArray(); areas.resize(node.n);
      markWalkableTriangles(ctx, o.maxSlope, verts, positions.length / 3, nodeTris, node.n, areas);
      if (edits.walkable.length) {
        // hand-marked "walkable" boxes: steep triangles inside count as floor too
        for (let t = 0; t < node.n; t++) {
          if (areas.get(t)) continue;
          let cx = 0, cy = 0, cz = 0;
          for (let k = 0; k < 3; k++) { const v = nodeTris.get(t * 3 + k) * 3; cx += positions[v]; cy += positions[v + 1]; cz += positions[v + 2]; }
          if (edits.walkable.some((b) => inBox(b, cx / 3, cy / 3, cz / 3))) areas.set(t, AREA.walk);
        }
      }
      rasterizeTriangles(ctx, verts, positions.length / 3, nodeTris, areas, node.n, hf, climb);
      areas.destroy();
    }
    filterLowHangingWalkableObstacles(ctx, climb, hf);
    filterLedgeSpans(ctx, hProne, climb, hf);
    filterWalkableLowHeightSpans(ctx, hProne, hf);
    const chf = allocCompactHeightfield();
    buildCompactHeightfield(ctx, hProne, climb, hf, chf);
    freeHeightfield(hf);
    erodeWalkableArea(ctx, radius, chf);

    // headroom per floor cell: standing, crouched or prone only
    const raw = chf.raw;
    const spanCount = raw.get_spanCount();
    if (spanCount) {
      const base = M.getPointer(raw.get_spans(0)) >>> 2; // rcCompactSpan = {u16 y, u16 reg, u32 con:24|h:8}
      const heap = M.HEAPU32;
      for (let i = 0; i < spanCount; i++) {
        const h = heap[base + i * 2 + 1] >>> 24;
        if (h >= hStand) continue;
        if (!raw.get_areas(i)) continue;
        raw.set_areas(i, h >= hCrouch ? AREA.crouch : AREA.prone);
      }
    }
    for (const b of edits.avoid) markBoxArea(ctx, b.min, b.max, AREA.avoid, chf);
    for (const b of edits.block) markBoxArea(ctx, b.min, b.max, 0, chf);

    buildDistanceField(ctx, chf);
    buildRegions(ctx, chf, border, minSide * minSide, 400);
    const cset = allocContourSet();
    buildContours(ctx, chf, 1.3, 60, cset, Recast.RC_CONTOUR_TESS_WALL_EDGES | Recast.RC_CONTOUR_TESS_AREA_EDGES);
    const pm = allocPolyMesh();
    if (buildPolyMesh(ctx, cset, 6, pm)) { out.addTile(pm); built++; }
    freePolyMesh(pm);
    freeContourSet(cset);
    freeCompactHeightfield(chf);
  }
  onProgress(tilesX * tilesZ, tilesX * tilesZ);
  chunkIds.destroy(); verts.destroy(); tris.destroy();
  const res = out.finish();
  res.stats = { tiles: tilesX * tilesZ, tilesWithFloor: built, triangles: nTris, seconds: (Date.now() - t0) / 1000 };
  return res;
}

/** Collects the polygons of all tiles, joins shared corners and finds each edge's neighbour. */
class Merger {
  constructor(o) {
    this.o = o;
    this.verts = []; // x,y,z
    this.byXZ = new Map(); // "ix,iz" -> [vertex index]
    this.polys = []; // { v: [...], area }
  }

  vertex(x, y, z) {
    const key = Math.round(x / this.o.cs) + ',' + Math.round(z / this.o.cs);
    let list = this.byXZ.get(key);
    if (!list) this.byXZ.set(key, (list = []));
    // corners on tile borders are the same cell; their heights can differ by a few cells
    for (const i of list) if (Math.abs(this.verts[i * 3 + 1] - y) <= this.o.ch * 4) return i;
    const i = this.verts.length / 3;
    this.verts.push(x, y, z);
    list.push(i);
    return i;
  }

  addTile(pm) {
    const nvp = pm.nvp(), np = pm.npolys();
    if (!np) return;
    const b = pm.bmin(), cs = pm.cs(), ch = pm.ch();
    const nv = pm.nverts();
    const local = new Int32Array(nv);
    for (let i = 0; i < nv; i++) {
      local[i] = this.vertex(b.x + pm.verts(i * 3) * cs, b.y + pm.verts(i * 3 + 1) * ch, b.z + pm.verts(i * 3 + 2) * cs);
    }
    for (let p = 0; p < np; p++) {
      const v = [];
      for (let j = 0; j < nvp; j++) {
        const k = pm.polys(p * nvp * 2 + j);
        if (k === 0xffff) break;
        v.push(local[k]);
      }
      if (v.length >= 3) this.polys.push({ v, area: AREA_NAME[pm.areas(p)] || 'walk' });
    }
  }

  finish() {
    const edges = new Map();
    this.polys.forEach((p, pi) => {
      p.neighbours = new Array(p.v.length).fill(-1);
      p.v.forEach((a, j) => {
        const b = p.v[(j + 1) % p.v.length];
        const key = a < b ? a + ',' + b : b + ',' + a;
        const other = edges.get(key);
        if (other) {
          p.neighbours[j] = other.p;
          this.polys[other.p].neighbours[other.j] = pi;
          edges.delete(key);
        } else edges.set(key, { p: pi, j });
      });
    });
    // tile seams where the two sides split the border differently (T-joints): join edges that
    // lie on the same axis-aligned line and overlap
    const V = this.verts, cs = this.o.cs;
    const lines = new Map();
    for (const { p, j } of edges.values()) {
      const poly = this.polys[p];
      const a = poly.v[j], b = poly.v[(j + 1) % poly.v.length];
      for (const k of [0, 2]) {
        if (Math.abs(V[a * 3 + k] - V[b * 3 + k]) > 1e-3) continue;
        const o = 2 - k; // the coordinate along the line
        const e = { p, j, lo: Math.min(V[a * 3 + o], V[b * 3 + o]), hi: Math.max(V[a * 3 + o], V[b * 3 + o]), y: (V[a * 3 + 1] + V[b * 3 + 1]) / 2 };
        const key = k + ':' + Math.round(V[a * 3 + k] / cs);
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(e);
      }
    }
    for (const list of lines.values()) {
      for (let i = 0; i < list.length; i++) for (let m = i + 1; m < list.length; m++) {
        const e = list[i], f = list[m];
        if (e.p === f.p || Math.min(e.hi, f.hi) - Math.max(e.lo, f.lo) < cs || Math.abs(e.y - f.y) > this.o.step + this.o.ch * 4) continue;
        const pe = this.polys[e.p], pf = this.polys[f.p];
        if (pe.neighbours[e.j] < 0) pe.neighbours[e.j] = f.p;
        if (pf.neighbours[f.j] < 0) pf.neighbours[f.j] = e.p;
      }
    }
    return this.dropSmallIslands();
  }

  /**
   * Recast keeps small patches that touch a tile border (the tops of stones, tree bases...).
   * Drop every connected group of polygons smaller than minIsland m², then renumber.
   */
  dropSmallIslands() {
    const V = this.verts, P = this.polys;
    const area = (p) => {
      let a = 0;
      for (let j = 1; j < p.v.length - 1; j++) {
        const [o, b, c] = [p.v[0], p.v[j], p.v[j + 1]].map((i) => i * 3);
        a += Math.abs((V[b] - V[o]) * (V[c + 2] - V[o + 2]) - (V[c] - V[o]) * (V[b + 2] - V[o + 2])) / 2;
      }
      return a;
    };
    const group = new Int32Array(P.length).fill(-1);
    const keep = new Uint8Array(P.length);
    for (let s = 0; s < P.length; s++) {
      if (group[s] >= 0) continue;
      const members = [s];
      group[s] = s;
      let total = 0;
      for (let k = 0; k < members.length; k++) {
        const p = P[members[k]];
        total += area(p);
        for (const nb of p.neighbours) if (nb >= 0 && group[nb] < 0) { group[nb] = s; members.push(nb); }
      }
      if (total >= this.o.minIsland) for (const m of members) keep[m] = 1;
    }
    const newIndex = new Int32Array(P.length).fill(-1);
    const polys = [];
    P.forEach((p, i) => { if (keep[i]) { newIndex[i] = polys.length; polys.push(p); } });
    const vIndex = new Int32Array(V.length / 3).fill(-1);
    const verts = [];
    for (const p of polys) {
      p.neighbours = p.neighbours.map((n) => (n >= 0 ? newIndex[n] : -1));
      p.v = p.v.map((v) => {
        if (vIndex[v] < 0) { vIndex[v] = verts.length / 3; verts.push(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]); }
        return vIndex[v];
      });
    }
    return { vertices: Float32Array.from(verts), polygons: polys, dropped: P.length - polys.length };
  }
}
