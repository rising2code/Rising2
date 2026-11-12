// Nebula 2 mesh files: binary ".nvx2" and text ".n3d2".
// Only what the editor needs is decoded: vertex positions, triangle indices and groups
// (a shape node picks one group with ".setgroupindex").

/**
 * @returns {{positions: Float32Array, indices: Uint32Array, groups: {firstTri:number,numTris:number}[], vertexWidth:number, components:number}}
 */
export function parseNvx2(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== '2XVN' && magic !== 'NVX2') throw new Error('not an NVX2 file');
  const numGroups = dv.getUint32(4, true);
  const numVerts = dv.getUint32(8, true);
  const vw = dv.getUint32(12, true);
  const numTris = dv.getUint32(16, true);
  const components = dv.getUint32(24, true);
  const groups = [];
  let p = 28;
  for (let g = 0; g < numGroups; g++) {
    groups.push({
      firstVert: dv.getUint32(p, true), numVerts: dv.getUint32(p + 4, true),
      firstTri: dv.getUint32(p + 8, true), numTris: dv.getUint32(p + 12, true),
    });
    p += 24;
  }
  const positions = new Float32Array(numVerts * 3);
  // vertex layout: coord(3) [normal(3)] [uv0(2)] ...; only coord and uv0 are used here
  const hasUv = (components & 4) !== 0;
  const uvOff = (3 + (components & 2 ? 3 : 0)) * 4;
  const uvs = hasUv ? new Float32Array(numVerts * 2) : null;
  for (let i = 0; i < numVerts; i++) {
    const o = p + i * vw * 4;
    positions[i * 3] = dv.getFloat32(o, true);
    positions[i * 3 + 1] = dv.getFloat32(o + 4, true);
    positions[i * 3 + 2] = dv.getFloat32(o + 8, true);
    if (uvs) {
      uvs[i * 2] = dv.getFloat32(o + uvOff, true);
      uvs[i * 2 + 1] = dv.getFloat32(o + uvOff + 4, true);
    }
  }
  p += numVerts * vw * 4;
  const indices = new Uint32Array(numTris * 3);
  for (let i = 0; i < numTris * 3; i++) indices[i] = dv.getUint16(p + i * 2, true);
  return { positions, uvs, indices, groups, vertexWidth: vw, components };
}

export function parseN3d2(text) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const groups = [];
  let uvAt = -1;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'vertexcomps') {
      let off = 0;
      for (const c of t.slice(1)) {
        if (c === 'uv0') uvAt = off;
        off += { coord: 3, normal: 3, uv0: 2, uv1: 2, uv2: 2, uv3: 2, color: 4, tangent: 3, binormal: 3, weights: 4, jindices: 4 }[c] || 0;
      }
    } else if (t[0] === 'v') {
      positions.push(+t[1], +t[2], +t[3]);
      if (uvAt >= 0) uvs.push(+t[1 + uvAt], +t[2 + uvAt]);
    }
    else if (t[0] === 't') indices.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'g') groups.push({ firstVert: +t[1], numVerts: +t[2], firstTri: +t[3], numTris: +t[4] });
  }
  if (!groups.length) groups.push({ firstVert: 0, numVerts: positions.length / 3, firstTri: 0, numTris: indices.length / 3 });
  return {
    positions: new Float32Array(positions), uvs: uvs.length ? new Float32Array(uvs) : null,
    indices: new Uint32Array(indices), groups, vertexWidth: 0, components: 0,
  };
}

export function parseMesh(fileName, bytes) {
  if (/\.n3d2$/i.test(fileName)) return parseN3d2(new TextDecoder('latin1').decode(bytes));
  return parseNvx2(bytes);
}
