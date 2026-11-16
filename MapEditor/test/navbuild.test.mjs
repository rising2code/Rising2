// Navigation map builder on made-up geometry: a 40 x 40 m floor with a 1.5 m high roof
// (crouch room only), a 1.0 m high roof (prone only) and a block area.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavmesh } from '../src/main/navbuild.mjs';

function quad(pos, idx, [x0, y, z0], [x1, , z1], up = true) {
  const b = pos.length / 3;
  pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  // counter-clockwise seen from above = facing up in Recast's terms
  if (up) idx.push(b, b + 2, b + 1, b, b + 3, b + 2); else idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}

function areaAt(res, x, z) {
  const V = res.vertices;
  for (const p of res.polygons) {
    let inside = false;
    for (let i = 0, j = p.v.length - 1; i < p.v.length; j = i++) {
      const xi = V[p.v[i] * 3], zi = V[p.v[i] * 3 + 2], xj = V[p.v[j] * 3], zj = V[p.v[j] * 3 + 2];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return p.area;
  }
  return null;
}

test('areas follow the headroom, block boxes remove floor', async () => {
  const pos = [], idx = [];
  quad(pos, idx, [0, 0, 0], [40, 0, 40]);
  quad(pos, idx, [5, 1.5, 5], [15, 1.5, 15], false); // roof 1.5 m up
  quad(pos, idx, [25, 1.0, 5], [35, 1.0, 15], false); // roof 1.0 m up
  const res = await buildNavmesh({
    positions: Float32Array.from(pos), indices: Uint32Array.from(idx),
    bounds: [[0, -1, 0], [40, 3, 40]],
    edits: { block: [{ min: [20, -1, 25], max: [30, 2, 35] }] },
  });
  assert.equal(areaAt(res, 10, 30), 'walk');
  assert.equal(areaAt(res, 10, 10), 'crouch');
  assert.equal(areaAt(res, 30, 10), 'prone');
  assert.equal(areaAt(res, 25, 30), null);
  // every polygon edge points to a polygon or to -1
  for (const p of res.polygons) for (const n of p.neighbours) assert.ok(n >= -1 && n < res.polygons.length);
  assert.ok(res.polygons.some((p) => p.neighbours.some((n) => n >= 0)));
});
