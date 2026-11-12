// Round-trip tests against a real installed level. Set RE_LEVEL to another level folder
// to test it; the default is the Eiffel level. Files are only read, never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseN2, writeN2, nodeFromTemplate, templateFromNode } from '../src/renderer/lib/n2.js';
import { parseNvx2 } from '../src/renderer/lib/mesh.js';
import { decodeDds, encodeDds, readDdsHeader } from '../src/renderer/lib/dds.js';
import {
  decodeHeightmap, encodeHeightmap, terrainMeshCrc, parseLightmapMdat, writeLightmapMdat,
  lightmapKey, decodeLevelDat, encodeLevelDat,
} from '../src/renderer/lib/levelfiles.js';

const LEVEL = process.env.RE_LEVEL || 'E:/RisingEagle/Install_4/data/levels/france/eiffel';
const NAME = path.basename(LEVEL);
const read = (p) => new Uint8Array(fs.readFileSync(path.join(LEVEL, p)));
const have = fs.existsSync(LEVEL);

test('level .n2 round-trips byte for byte', { skip: !have }, () => {
  const text = fs.readFileSync(path.join(LEVEL, NAME + '.n2'), 'latin1');
  const doc = parseN2(text);
  assert.equal(writeN2(doc), text);
  assert.ok(doc.root.child('entities').children.length > 10);
});

test('terrain .setcrc matches terrainmesh.nvx2', { skip: !have }, () => {
  const doc = parseN2(fs.readFileSync(path.join(LEVEL, NAME + '.n2'), 'latin1'));
  const crc = Number(doc.root.child('terrain').cmd('setcrc').args[0]);
  assert.equal(terrainMeshCrc(read('terrain/meshes/terrainmesh.nvx2')), crc);
});

test('heightmap encodes back to the same heights', { skip: !have }, () => {
  const doc = parseN2(fs.readFileSync(path.join(LEVEL, NAME + '.n2'), 'latin1'));
  const t = doc.root.child('terrain');
  const min = Number(t.cmd('setminheight').args[0]);
  const hm = decodeHeightmap(read('terrain/textures/heightmap.bmp'), min);
  const mesh = parseNvx2(read('terrain/meshes/terrainmesh.nvx2'));
  const spacing = Number(t.cmd('setsize').args[0]) / Number(t.cmd('setresolution').args[0]);
  let maxErr = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] / spacing, z = mesh.positions[i + 2] / spacing;
    if (x !== Math.floor(x) || z !== Math.floor(z)) continue;
    maxErr = Math.max(maxErr, Math.abs(hm.heights[z * hm.width + x] - mesh.positions[i + 1]));
  }
  assert.ok(maxErr < 0.02, `max error ${maxErr}`);
  const enc = encodeHeightmap(hm.heights, hm.width, hm.height);
  const back = decodeHeightmap(enc.bytes, enc.minHeight);
  for (let i = 0; i < back.heights.length; i += 97) assert.ok(Math.abs(back.heights[i] - hm.heights[i]) < 1e-3);
});

test('lightmap.mdat round-trips and keys match node paths', { skip: !have }, () => {
  const bytes = read('maps/lightmap.mdat');
  const recs = parseLightmapMdat(bytes);
  assert.deepEqual(writeLightmapMdat(recs), bytes);
  const doc = parseN2(fs.readFileSync(path.join(LEVEL, NAME + '.n2'), 'latin1'));
  let matched = 0;
  for (const n of doc.root.walk()) if (n.parent && recs.has(lightmapKey(n.path()))) matched++;
  console.log(`lightmap records ${recs.size}, matched to nodes ${matched}`);
  assert.ok(matched > recs.size * 0.9);
});

test('level .dat decodes and re-encodes identically', { skip: !have }, () => {
  const bytes = read(NAME + '.dat');
  const text = decodeLevelDat(bytes);
  assert.match(text, /\[Name\]/);
  assert.deepEqual(encodeLevelDat(text), bytes);
});

test('DDS decode and DXT encode', { skip: !have }, () => {
  const d = decodeDds(read(NAME + '.dds'));
  assert.equal(d.width, readDdsHeader(read(NAME + '.dds')).width);
  for (const f of ['DXT1', 'DXT5', 'A8R8G8B8']) {
    const enc = encodeDds(d.rgba, d.width, d.height, f, true);
    const back = decodeDds(enc);
    let err = 0;
    for (let i = 0; i < d.rgba.length; i += 4) err += Math.abs(back.rgba[i] - d.rgba[i]);
    assert.ok(err / (d.rgba.length / 4) < 12, `${f} mean error ${err / (d.rgba.length / 4)}`);
  }
});

test('entity template -> node -> template', () => {
  const tpl = fs.readFileSync('E:/RisingEagle/Install_4/data/entities/misc/flag_object.n2', 'latin1');
  const node = nodeFromTemplate(tpl, 'flag_object?9');
  assert.equal(node.cls, 'mblvictorypoint');
  assert.ok(node.children.length >= 1);
  const again = nodeFromTemplate(templateFromNode(node), 'x');
  assert.equal(again.items.length, node.items.length);
});
