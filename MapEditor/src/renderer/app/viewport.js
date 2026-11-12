// The 3D view: one three.js Group per .n2 node, bounding boxes (level 1), real models in
// solid / wireframe / textured mode (level 2), the terrain, spawn points, the move/rotate/
// scale gizmo, the terrain brush (level 4) and off-screen renders for minimaps (level 3).
//
// Coordinates are the game's: metres, Y up. Node transforms follow Nebula 2:
// .setposition x y z, .seteuler x y z (degrees in this game, applied X then Y then Z),
// .setscale x y z. ".setlocalbox cx cy cz ex ey ez" is a box centre and half-size.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { loadMesh, loadDds, join } from './level.js';
import { fmt, unquote } from '../lib/n2.js';

const DEG = Math.PI / 180;
const EULER_ORDER = 'ZYX'; // three.js name for "rotate X first, then Y, then Z"

export const CATEGORY = {
  static: { color: 0x8fa7c4, label: 'Static object' },
  breakable: { color: 0xe39b4f, label: 'Breakable' },
  tree: { color: 0x5fb35f, label: 'Tree' },
  turret: { color: 0xe0504a, label: 'Turret' },
  flag: { color: 0xf2d43a, label: 'Flag / victory point' },
  ad: { color: 0xb27ce0, label: 'Billboard' },
  light: { color: 0xfff3a0, label: 'Light' },
  occluder: { color: 0x666a72, label: 'Occluder' },
  other: { color: 0xa0a4ab, label: 'Other' },
};

export function categoryOf(node) {
  let top = node;
  while (top.parent && top.parent.parent && top.parent.name !== 'entities') top = top.parent;
  if (node.cls === 'nlightnode') return 'light';
  if (node.cls === 'noccludernode') return 'occluder';
  switch (top.cls) {
    case 'nspeedtreenode': return 'tree';
    case 'mblturret': return 'turret';
    case 'mblvictorypoint': return 'flag';
    case 'nadentitynode': return 'ad';
    case 'nstaticnode': {
      const t = top.cmd('setentitytype');
      return t && t.args[0] === '2' ? 'breakable' : 'static';
    }
    default: return 'other';
  }
}

const isShape = (n) => !!n.cmd('setmesh');

/**
 * Euler angles (degrees) for a rotation, choosing among the equivalent answers the one
 * closest to the previous values, so turning an object 120° about Y gives "0 120 0"
 * rather than the equivalent "180 60 180".
 */
export function eulerNear(quaternion, old) {
  const r = new THREE.Euler().setFromQuaternion(quaternion, EULER_ORDER);
  const a = [r.x / DEG, r.y / DEG, r.z / DEG];
  const b = [a[0] + 180, 180 - a[1], a[2] + 180]; // the other solution of the same rotation
  const near = (v, ref) => v - 360 * Math.round((v - ref) / 360);
  const fit = (s) => s.map((v, i) => near(v, old[i]));
  const fa = fit(a), fb = fit(b);
  const dist = (s) => s.reduce((t, v, i) => t + Math.abs(v - old[i]), 0);
  return dist(fa) <= dist(fb) ? fa : fb;
}

export class Viewport extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.level = null;
    this.viewMode = 'boxes';
    this.objects = new Map(); // node.uid -> Group
    this.selection = [];      // [{node} | {spawn: cmdItem}], last one = the "active" object
    this.pivotMode = 'center'; // multi-selection: 'center' | 'active' | 'individual'
    this.needsRender = true;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false }));
    r.setPixelRatio(window.devicePixelRatio);
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x30343a);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 6000);
    this.camera.position.set(500, 120, 700);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.4, 1, 0.3);
    this.scene.add(sun);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.spawnGroup = new THREE.Group();
    this.scene.add(this.spawnGroup);

    this.orbit = new OrbitControls(this.camera, r.domElement);
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.screenSpacePanning = false;
    // allow looking up (camera below its pivot); the ground clamp in the render loop keeps
    // the camera from going under the terrain instead
    this.orbit.maxPolarAngle = Math.PI * 0.97;
    this.orbit.zoomToCursor = true; // wheel zooms towards the point under the mouse
    this.orbit.minDistance = 0.5;
    this.fly = new Set(); // held fly keys (WASD QE, Shift)
    this.orbit.addEventListener('change', () => this.invalidate());

    this.gizmo = new TransformControls(this.camera, r.domElement);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('change', () => this.invalidate());
    // with several objects selected the gizmo drives this helper object (the pivot) and the
    // pivot's movement is applied to every selected object
    this.pivot = new THREE.Object3D();
    this.scene.add(this.pivot);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) {
        this._dragTargets = [...this.selection];
        this._dragStart = this._dragTargets.map((t) => this.captureTransform(t));
        if (this._dragTargets.length > 1) this.beginGroupDrag();
      } else if (this._dragStart) {
        const targets = this._dragTargets, before = this._dragStart;
        this._dragStart = this._dragTargets = this._group = null;
        for (const t of targets) this.writeBack(t);
        this.dispatchEvent(new CustomEvent('transformed', { detail: { targets, before, after: targets.map((t) => this.captureTransform(t)) } }));
        if (targets.length > 1) this.placePivot();
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this._group) this.applyGroupDrag();
      this.updateSelectionBox();
      this.dispatchEvent(new CustomEvent('moving', { detail: this.selection }));
    });

    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffff40);
    this.selBox.visible = false;
    this.scene.add(this.selBox);

    // shared box geometry for bounding boxes and click targets
    this.unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.lineMats = {};
    this.solidMats = {};
    this.wireMats = {};
    for (const [k, v] of Object.entries(CATEGORY)) {
      this.lineMats[k] = new THREE.LineBasicMaterial({ color: v.color });
      this.solidMats[k] = new THREE.MeshLambertMaterial({ color: v.color, side: THREE.DoubleSide });
      this.wireMats[k] = new THREE.MeshBasicMaterial({ color: v.color, wireframe: true });
    }
    this.pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.texMats = new Map();
    this.geoCache = new Map();

    this.raycaster = new THREE.Raycaster();
    this.brush = { op: 'raise', radius: 10, strength: 0.3, height: 0 };
    this.mode = 'translate';
    this._initPointer();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    let last = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // OrbitControls pans in proportion to the distance to its pivot, which crawls when
      // zoomed in close; never pan slower than as if the pivot were 40 m away
      this.orbit.panSpeed = Math.min(80, Math.max(1, 40 / (this.camera.position.distanceTo(this.orbit.target) || 1)));
      if (this.fly.size) this.flyStep(dt);
      this.keepAboveGround();
      if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  invalidate() { this.needsRender = true; }

  /** Fly keys: W/S forward and back along the view, A/D sideways, Q/E down and up, Shift = fast. */
  setFlyKey(code, down) {
    if (down) this.fly.add(code); else this.fly.delete(code);
  }

  flyStep(dt) {
    const k = this.fly;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const move = new THREE.Vector3();
    if (k.has('KeyW')) move.add(fwd);
    if (k.has('KeyS')) move.sub(fwd);
    if (k.has('KeyD')) move.add(right);
    if (k.has('KeyA')) move.sub(right);
    if (k.has('KeyE')) move.y += 1;
    if (k.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    // speed grows with height above the ground so crossing the map stays quick
    const ground = this.level ? this.level.heightAt(this.camera.position.x, this.camera.position.z) : 0;
    const speed = Math.max(8, (this.camera.position.y - ground) * 0.8) * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1);
    move.normalize().multiplyScalar(speed * dt);
    this.camera.position.add(move);
    this.orbit.target.add(move);
    this.orbit.update();
    this.invalidate();
  }

  /** See-through models (Solid and Textured views). 1 = normal. */
  setOpacity(v) {
    this.opacity = v;
    for (const m of Object.values(this.solidMats)) this.applyOpacity(m);
    for (const m of this.texMats.values()) this.applyOpacity(m);
    this.invalidate();
  }

  applyOpacity(mat, v = this.opacity ?? 1) {
    const see = v < 0.999;
    mat.opacity = v;
    mat.transparent = see;
    mat.depthWrite = !see; // otherwise near see-through walls would hide what is behind them
    mat.needsUpdate = true;
  }

  /** If the camera dipped under the terrain, lift camera and pivot together (the view angle stays). */
  keepAboveGround() {
    if (!this.level || !this.level.terrain || (this.terrainMesh && !this.terrainMesh.visible)) return;
    const c = this.camera.position;
    const min = this.level.heightAt(c.x, c.z) + 0.6;
    if (c.y >= min) return;
    const dy = min - c.y;
    c.y += dy;
    this.orbit.target.y += dy;
    this.orbit.update();
    this.invalidate();
  }

  /** Close-up of the selection looking straight down (north = up, like the minimap). */
  focusTop() {
    if (!this.selection.length) return;
    this.updateSelectionBox();
    const b = this.selBox.box;
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const h = Math.max(12, Math.max(size.x, size.z) * 1.6) + size.y / 2;
    this.orbit.target.copy(c);
    this.camera.position.set(c.x, c.y + h, c.z + h * 0.001); // tiny offset keeps -Z at the top of the screen
    this.orbit.update();
    this.invalidate();
  }

  /** PNG data URL of the current view (renders synchronously so the buffer is valid). */
  snapshotDataUrl() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  // ---------------------------------------------------------------- building

  setLevel(level) {
    this.level = level;
    this.select(null);
    this.world.clear();
    this.spawnGroup.clear();
    this.objects.clear();
    this.meshes = [];
    this.pickables = [];
    // the terrain lives directly in the scene, so remove the previous level's one explicitly
    if (this.terrainMesh) {
      this.terrainMesh.removeFromParent();
      this.terrainMesh.geometry.dispose();
      this.terrainMesh = null;
    }
    if (this._terrainTex) {
      for (const t of [...this._terrainTex.uniforms.layer.value, ...this._terrainTex.uniforms.weight.value]) t.dispose();
      this._terrainTex.dispose();
      this._terrainTex = null;
    }
    // models and textures are cached per level (another level may come from another install)
    for (const p of this.geoCache.values()) p.then((g) => g && g.dispose());
    this.geoCache.clear();
    for (const m of this.texMats.values()) { if (m.map) m.map.dispose(); m.dispose(); }
    this.texMats.clear();

    for (const child of level.root.children) {
      if (child === level.terrainNode) continue;
      this.world.add(this.buildNode(child));
    }
    if (level.terrain) this.buildTerrain();
    this.buildSpawns();
    this.setViewMode(this.viewMode);

    // start looking at the middle of what is placed
    const box = new THREE.Box3();
    for (const n of level.entities.children) {
      const p = n.nums('setposition');
      if (p) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
    }
    const c = box.isEmpty() ? new THREE.Vector3(512, 0, 512) : box.getCenter(new THREE.Vector3());
    this.orbit.target.copy(c);
    this.camera.position.set(c.x, c.y + 180, c.z + 220);
    this.orbit.update();
    this.invalidate();
  }

  applyTransform(node, obj) {
    const p = node.nums('setposition') || [0, 0, 0];
    const e = node.nums('seteuler') || [0, 0, 0];
    const s = node.nums('setscale') || [1, 1, 1];
    obj.position.set(p[0], p[1], p[2]);
    obj.rotation.set(e[0] * DEG, e[1] * DEG, e[2] * DEG, EULER_ORDER);
    obj.scale.set(s[0], s[1], s[2]);
  }

  buildNode(node) {
    const g = new THREE.Group();
    g.name = node.name;
    g.userData.node = node;
    this.objects.set(node.uid, g);
    this.applyTransform(node, g);
    if (node.name === 'sky' || node.cls === 'nskinanimator' || node.cls === 'ntransformanimator') {
      g.visible = node.name !== 'sky';
    }
    const cat = categoryOf(node);
    const lb = node.nums('setlocalbox');
    const shape = isShape(node);
    const hasShapeBelow = () => [...node.walk()].some((n) => n !== node && isShape(n));
    if (lb && lb.length >= 6 && (shape || (!hasShapeBelow() && node.parent !== this.level?.root))) {
      const center = new THREE.Vector3(lb[0], lb[1], lb[2]);
      const size = new THREE.Vector3(Math.max(lb[3] * 2, 0.05), Math.max(lb[4] * 2, 0.05), Math.max(lb[5] * 2, 0.05));
      const lines = new THREE.LineSegments(this.unitEdges, this.lineMats[cat]);
      lines.position.copy(center);
      lines.scale.copy(size);
      lines.userData.boxVis = true;
      g.add(lines);
      const pick = new THREE.Mesh(this.unitBox, this.pickMat);
      pick.position.copy(center);
      pick.scale.copy(size);
      pick.userData.pickProxy = true;
      g.add(pick);
      this.pickables.push(pick);
    } else if (!lb && node.parent && node.parent.name === 'entities' && !hasShapeBelow()) {
      const lines = new THREE.LineSegments(this.unitEdges, this.lineMats[cat]);
      lines.userData.boxVis = true;
      g.add(lines);
      const pick = new THREE.Mesh(this.unitBox, this.pickMat);
      pick.userData.pickProxy = true;
      g.add(pick);
      this.pickables.push(pick);
    }
    if (shape) {
      g.userData.shape = {
        mesh: unquote(node.cmd('setmesh').args[0]),
        group: Number((node.cmd('setgroupindex') || { args: ['0'] }).args[0]),
        cat,
        hidden: (node.cmd('setactive') || { args: ['true'] }).args[0] === 'false', // e.g. invisible map borders
      };
      this.meshes.push(g);
    }
    for (const c of node.children) g.add(this.buildNode(c));
    return g;
  }

  /** Rebuilds the objects of one node (after a copy, undo, property edit...). */
  rebuildNode(node) {
    const old = this.objects.get(node.uid);
    const parentObj = node.parent && node.parent !== this.level.root ? this.objects.get(node.parent.uid) : this.world;
    if (old) this.forgetObject(old);
    const g = this.buildNode(node);
    (parentObj || this.world).add(g);
    if (this.viewMode !== 'boxes') this.ensureModels(g);
    this.applyViewMode(g);
    if (this.selection.some((t) => t.node === node)) this.select(this.selection);
    this.invalidate();
    return g;
  }

  removeNodeObject(node) {
    const old = this.objects.get(node.uid);
    if (old) this.forgetObject(old);
    this.invalidate();
  }

  forgetObject(obj) {
    obj.traverse((o) => {
      if (o.userData.node) this.objects.delete(o.userData.node.uid);
      const i = this.pickables.indexOf(o);
      if (i >= 0) this.pickables.splice(i, 1);
      const k = this.meshes.indexOf(o);
      if (k >= 0) this.meshes.splice(k, 1);
    });
    obj.removeFromParent();
  }

  refreshTransform(node) {
    const g = this.objects.get(node.uid);
    if (g) this.applyTransform(node, g);
    this.updateSelectionBox();
    this.invalidate();
  }

  // ---------------------------------------------------------------- models (level 2)

  async geometryFor(meshPath, groupIndex) {
    const key = meshPath + '#' + groupIndex;
    if (!this.geoCache.has(key)) {
      this.geoCache.set(key, loadMesh(this.level, meshPath).then((m) => {
        if (!m) return null;
        const grp = m.groups[groupIndex] || m.groups[0];
        if (!grp) return null;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
        if (m.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
        geo.setIndex(new THREE.BufferAttribute(m.indices.subarray(grp.firstTri * 3, (grp.firstTri + grp.numTris) * 3), 1));
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        return geo;
      }));
    }
    return this.geoCache.get(key);
  }

  /** Loads the real model of every shape below `root` (once). */
  ensureModels(root = this.world) {
    const jobs = [];
    root.traverse((g) => {
      const s = g.userData.shape;
      if (!s || g.userData.modelMesh !== undefined) return;
      g.userData.modelMesh = null;
      jobs.push(this.geometryFor(s.mesh, s.group).then((geo) => {
        if (!geo || !g.parent) return;
        const m = new THREE.Mesh(geo, this.materialFor(g));
        m.userData.model = true;
        g.userData.modelMesh = m;
        g.add(m);
        this.applyViewMode(m);
        this.invalidate();
      }));
    });
    return Promise.all(jobs);
  }

  materialFor(g) {
    const s = g.userData.shape;
    if (this.viewMode === 'wire') return this.wireMats[s.cat];
    if (this.viewMode === 'textured') return this.texturedMaterial(g.userData.node);
    return this.solidMats[s.cat];
  }

  texturedMaterial(node) {
    const tc = node.cmdsNamed('settexture').find((c) => unquote(c.args[0]) === 'DiffMap0');
    const path = tc ? unquote(tc.args[1]) : null;
    const transparent = (node.cmd('setittransparency') || { args: ['0'] }).args[0] !== '0';
    const key = path + '|' + transparent;
    if (!this.texMats.has(key)) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, alphaTest: transparent ? 0.4 : 0 });
      this.applyOpacity(mat);
      this.texMats.set(key, mat);
      if (path) {
        mat.userData.ready = loadDds(this.level.resolve(path)).then((img) => {
          if (!img) { mat.color.set(0xff00ff); return; }
          const t = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.colorSpace = THREE.SRGBColorSpace;
          t.magFilter = THREE.LinearFilter;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.generateMipmaps = true;
          t.needsUpdate = true;
          mat.map = t;
          mat.needsUpdate = true;
          this.invalidate();
        });
      }
    }
    return this.texMats.get(key);
  }

  setViewMode(mode) {
    this.viewMode = mode;
    if (!this.level) return Promise.resolve();
    const done = mode !== 'boxes' ? this.ensureModels() : Promise.resolve();
    for (const g of this.meshes) if (g.userData.modelMesh) g.userData.modelMesh.material = this.materialFor(g);
    this.world.traverse((o) => this.applyViewMode(o));
    if (this.terrainMesh) this.terrainMesh.material = mode === 'textured' ? this.terrainTexMat() : mode === 'wire' ? this.terrainWire : this.terrainSolid;
    this.invalidate();
    return done;
  }

  applyViewMode(root) {
    root.traverse((o) => {
      if (o.userData.boxVis) {
        // model views keep only the boxes of placed objects that have no model at all;
        // the textured view (used for minimaps) shows no boxes
        const owner = o.parent;
        const topLevel = owner.userData.node?.parent?.name === 'entities';
        o.visible = this.viewMode === 'boxes' || (this.viewMode !== 'textured' && !owner.userData.shape && topLevel);
      }
      if (o.userData.model) {
        // textured view shows what the game draws: shapes with ".setactive false" are skipped
        o.visible = this.viewMode !== 'boxes' && !(this.viewMode === 'textured' && o.parent.userData.shape.hidden);
        o.material = this.materialFor(o.parent);
      }
    });
  }

  // ---------------------------------------------------------------- terrain

  buildTerrain() {
    const t = this.level.terrain;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(t.width * t.height * 3);
    const uv = new Float32Array(t.width * t.height * 2);
    for (let j = 0; j < t.height; j++) for (let i = 0; i < t.width; i++) {
      const k = j * t.width + i;
      pos[k * 3] = i * t.spacing; pos[k * 3 + 1] = t.heights[k]; pos[k * 3 + 2] = j * t.spacing;
      uv[k * 2] = i / (t.width - 1); uv[k * 2 + 1] = j / (t.height - 1);
    }
    const idx = new Uint32Array((t.width - 1) * (t.height - 1) * 6);
    let n = 0;
    for (let j = 0; j < t.height - 1; j++) for (let i = 0; i < t.width - 1; i++) {
      const a = j * t.width + i, b = a + 1, c = a + t.width, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.terrainSolid = new THREE.MeshLambertMaterial({ color: 0x6d7f5a });
    this.terrainWire = new THREE.MeshBasicMaterial({ color: 0x55664a, wireframe: true });
    this.terrainMesh = new THREE.Mesh(geo, this.terrainSolid);
    this.terrainMesh.userData.terrain = true;
    this.terrainMesh.renderOrder = -1;
    this.terrainMesh.visible = this.terrainVisible !== false; // keep the "Terrain" checkbox setting
    this.scene.add(this.terrainMesh);
  }

  /** Approximation of the game's terrain look: 4 tiled layers blended by tex0..3. */
  terrainTexMat() {
    if (this._terrainTex) return this._terrainTex;
    const lv = this.level, tn = lv.terrainNode;
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    black.needsUpdate = true;
    const uniforms = { layer: { value: [black, black, black, black] }, weight: { value: [black, black, black, black] }, tiling: { value: [1, 1, 1, 1] } };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D layer[4]; uniform sampler2D weight[4]; uniform float tiling[4]; varying vec2 vUv;
        void main(){
          // tex0..3 are A8 masks; each layer is painted over the ones below it
          vec3 c = texture2D(layer[0], vUv * tiling[0]).rgb;
          c = mix(c, texture2D(layer[1], vUv * tiling[1]).rgb, texture2D(weight[1], vUv).a);
          c = mix(c, texture2D(layer[2], vUv * tiling[2]).rgb, texture2D(weight[2], vUv).a);
          c = mix(c, texture2D(layer[3], vUv * tiling[3]).rgb, texture2D(weight[3], vUv).a);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const toTex = (img, repeat) => {
      const t = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
      t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
      t.needsUpdate = true;
      return t;
    };
    const jobs = [];
    const layerCmds = tn ? tn.cmdsNamed('setlayertexture') : [];
    const matrices = tn ? tn.cmdsNamed('setlayermatrix') : [];
    layerCmds.forEach((c, k) => {
      const i = Number(c.args[0]);
      if (i > 3) return;
      uniforms.tiling.value[i] = matrices[k] ? Number(matrices[k].args[0]) : 1;
      jobs.push(loadDds(lv.resolve(unquote(c.args[1]))).then((img) => { if (img) uniforms.layer.value[i] = toTex(img, true); }));
    });
    for (let i = 0; i < 4; i++) {
      jobs.push(loadDds(join(lv.dir, 'terrain', 'textures', `tex${i}.dds`)).then((img) => { if (img) uniforms.weight.value[i] = toTex(img, false); }));
    }
    mat.userData.ready = Promise.all(jobs).then(() => { mat.needsUpdate = true; this.invalidate(); });
    this._terrainTex = mat;
    return mat;
  }

  updateTerrainRegion(i0, j0, i1, j1) {
    const t = this.level.terrain;
    const geo = this.terrainMesh.geometry;
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal.array;
    i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1); i1 = Math.min(t.width - 1, i1 + 1); j1 = Math.min(t.height - 1, j1 + 1);
    const H = (i, j) => t.heights[Math.min(t.height - 1, Math.max(0, j)) * t.width + Math.min(t.width - 1, Math.max(0, i))];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * t.width + i;
      pos[k * 3 + 1] = t.heights[k];
      const nx = H(i - 1, j) - H(i + 1, j), nz = H(i, j - 1) - H(i, j + 1), ny = 2 * t.spacing;
      const l = Math.hypot(nx, ny, nz);
      nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
    this.invalidate();
  }

  rebuildTerrainAll() {
    const t = this.level.terrain;
    this.updateTerrainRegion(0, 0, t.width - 1, t.height - 1);
  }

  /** Ray march against the heightfield (much faster than raycasting 260k triangles). */
  terrainHit(ray) {
    const lv = this.level;
    if (!lv || !lv.terrain) {
      const p = new THREE.Vector3();
      return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
    }
    const size = lv.terrain.size;
    const p = new THREE.Vector3();
    let prev = null;
    const step = lv.terrain.spacing * 0.5;
    for (let d = 0; d < 4000; d += step) {
      ray.at(d, p);
      if (p.x < -50 || p.z < -50 || p.x > size + 50 || p.z > size + 50) { prev = null; continue; }
      const above = p.y - lv.heightAt(p.x, p.z);
      if (above <= 0) {
        if (prev === null) return p.clone();
        // refine between d-step and d
        let a = d - step, b = d;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          ray.at(m, p);
          if (p.y - lv.heightAt(p.x, p.z) > 0) a = m; else b = m;
        }
        ray.at(b, p);
        return p.clone();
      }
      prev = above;
    }
    return null;
  }

  applyBrush(point, dt = 1) {
    const t = this.level.terrain;
    if (!t) return;
    const { op, radius, strength, height } = this.brush;
    const r = radius / t.spacing;
    const ci = point.x / t.spacing, cj = point.z / t.spacing;
    const i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(t.width - 1, Math.ceil(ci + r));
    const j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(t.height - 1, Math.ceil(cj + r));
    const src = op === 'smooth' ? t.heights.slice() : t.heights;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i - ci, j - cj) / r;
      if (d >= 1) continue;
      const f = (1 - d * d) * (1 - d * d); // soft falloff
      const k = j * t.width + i;
      if (op === 'raise') t.heights[k] += strength * f * dt;
      else if (op === 'lower') t.heights[k] -= strength * f * dt;
      else if (op === 'flatten') t.heights[k] += (height - t.heights[k]) * Math.min(1, strength * f * dt);
      else if (op === 'smooth') {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= t.width || jj >= t.height) continue;
          s += src[jj * t.width + ii]; n++;
        }
        t.heights[k] += (s / n - t.heights[k]) * Math.min(1, strength * f * dt);
      }
    }
    this.level.terrainDirty = true;
    this.updateTerrainRegion(i0, j0, i1, j1);
  }

  // ---------------------------------------------------------------- spawn points

  buildSpawns() {
    this.spawnGroup.clear();
    const cone = new THREE.ConeGeometry(0.45, 1.4, 10);
    cone.rotateX(Math.PI / 2); // point along +Z
    const colors = [0x4f9dff, 0xff5a4f, 0xd0d0d0];
    for (const c of this.level.root.cmdsNamed('setinsertionpoint')) {
      const side = Number(c.args[0]);
      const m = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: colors[side] ?? colors[2] }));
      m.userData.spawn = c;
      this.applySpawn(m);
      this.spawnGroup.add(m);
    }
  }

  applySpawn(m) {
    const a = m.userData.spawn.args.map(Number);
    m.position.set(a[2], a[3] + 0.9, a[4]);
    m.rotation.set(0, a[6] || 0, 0);
  }

  spawnObject(cmd) {
    return this.spawnGroup.children.find((m) => m.userData.spawn === cmd);
  }


  // ---------------------------------------------------------------- selection

  static same(a, b) { return a.node ? a.node === b.node : a.spawn === b.spawn; }

  /** Replace the selection. `targets`: null, one {node}/{spawn}, or an array of them. */
  select(targets) {
    const list = !targets ? [] : Array.isArray(targets) ? targets : [targets];
    // drop duplicates and things that no longer exist
    // (nodes without a 3D object, like 'Level settings' or the terrain, can still be selected for the properties panel)
    this.selection = list.filter((t, i) => list.findIndex((u) => Viewport.same(t, u)) === i && (t.node || this.objectOf(t)));
    this.gizmo.detach();
    const objs = this.selectedObjects();
    if (objs.length && this.mode !== 'terrain' && this.mode !== 'select') {
      const onlySpawns = this.selection.every((t) => t.spawn);
      if (objs.length === 1) this.gizmo.attach(objs[0]);
      else { this.placePivot(); this.gizmo.attach(this.pivot); }
      this.gizmo.setMode(onlySpawns && this.mode === 'scale' ? 'translate' : this.mode);
      // spawn points only turn about Y
      this.gizmo.showX = this.gizmo.showZ = !(onlySpawns && this.mode === 'rotate');
    }
    this.updateSelectionBox();
    this.dispatchEvent(new CustomEvent('selected', { detail: this.selection }));
    this.invalidate();
  }

  /** Ctrl+click: add or remove one target. */
  toggleSelect(target) {
    const i = this.selection.findIndex((t) => Viewport.same(t, target));
    if (i >= 0) this.select(this.selection.filter((_, k) => k !== i));
    else this.select([...this.selection, target]);
  }

  isSelected(target) { return this.selection.some((t) => Viewport.same(t, target)); }

  objectOf(t) {
    if (!t) return null;
    if (t.spawn) return this.spawnObject(t.spawn) || null;
    return this.objects.get(t.node.uid) || null;
  }

  selectedObjects() { return this.selection.map((t) => this.objectOf(t)).filter(Boolean); }

  /** The active (last selected) object. */
  selectedObject() { return this.objectOf(this.selection[this.selection.length - 1]); }

  boxOf(obj) {
    obj.updateWorldMatrix(true, true);
    const b = new THREE.Box3();
    obj.traverse((o) => {
      if ((o.userData.pickProxy || o.userData.model || o.userData.spawn) && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        b.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    });
    if (b.isEmpty()) b.setFromCenterAndSize(obj.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(1, 1, 1));
    return b;
  }

  updateSelectionBox() {
    const objs = this.selectedObjects();
    if (!objs.length) { this.selBox.visible = false; return; }
    const b = new THREE.Box3();
    for (const o of objs) b.union(this.boxOf(o));
    this.selBox.box.copy(b);
    this.selBox.visible = true;
  }

  setMode(mode) {
    this.mode = mode;
    // the Select tool uses left-drag for the selection rectangle; orbit moves to the middle button
    this.orbit.mouseButtons = mode === 'select'
      ? { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.select(this.selection);
  }

  setPivotMode(m) {
    this.pivotMode = m;
    this.select(this.selection);
  }

  setSnap(on) {
    this.gizmo.setTranslationSnap(on ? 0.5 : null);
    this.gizmo.setRotationSnap(on ? 15 * DEG : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  setSpace(local) {
    this.localAxes = local;
    this.gizmo.setSpace(local ? 'local' : 'world');
    this.select(this.selection);
  }

  // ---------------------------------------------------------------- group transform

  /**
   * Puts the pivot where multi-object rotate/scale turns around:
   *  center     - middle of the selection's bounding box
   *  active     - origin of the last selected object
   *  individual - gizmo in the middle, but each object rotates/scales about its own origin
   * With "Local axes" the pivot takes the active object's orientation.
   */
  placePivot() {
    const objs = this.selectedObjects();
    if (!objs.length) return;
    const active = this.selectedObject();
    if (this.pivotMode === 'active') active.getWorldPosition(this.pivot.position);
    else {
      this.updateSelectionBox();
      this.selBox.box.getCenter(this.pivot.position);
    }
    if (this.localAxes) active.getWorldQuaternion(this.pivot.quaternion);
    else this.pivot.quaternion.identity();
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
  }

  beginGroupDrag() {
    this.pivot.updateMatrixWorld(true);
    this._group = {
      pivotStart: this.pivot.matrixWorld.clone(),
      items: this._dragTargets.map((t) => {
        const obj = this.objectOf(t);
        obj.updateWorldMatrix(true, false);
        return { obj, start: obj.matrixWorld.clone(), origin: obj.getWorldPosition(new THREE.Vector3()) };
      }),
    };
  }

  applyGroupDrag() {
    const g = this._group;
    this.pivot.updateMatrixWorld(true);
    const P0 = g.pivotStart, P1 = this.pivot.matrixWorld;
    const c0 = new THREE.Vector3().setFromMatrixPosition(P0);
    const c1 = new THREE.Vector3().setFromMatrixPosition(P1);
    const lin = (m) => new THREE.Matrix4().extractRotation(m).multiply(new THREE.Matrix4().makeScale(...new THREE.Vector3().setFromMatrixScale(m).toArray()));
    const L = lin(P1).multiply(lin(P0).invert()); // rotation/scale change of the pivot
    const move = c1.clone().sub(c0);
    for (const it of g.items) {
      const about = this.pivotMode === 'individual' ? it.origin : c0;
      const m = new THREE.Matrix4().makeTranslation(about.x + move.x, about.y + move.y, about.z + move.z)
        .multiply(L)
        .multiply(new THREE.Matrix4().makeTranslation(-about.x, -about.y, -about.z))
        .multiply(it.start);
      it.obj.parent.updateWorldMatrix(true, false);
      const local = new THREE.Matrix4().copy(it.obj.parent.matrixWorld).invert().multiply(m);
      local.decompose(it.obj.position, it.obj.quaternion, it.obj.scale);
    }
  }

  /** Snapshot of one target's transform args, for undo. */
  captureTransform(t) {
    if (!t) return null;
    if (t.spawn) return { spawn: [...t.spawn.args] };
    const g = (n) => (t.node.cmd(n) ? [...t.node.cmd(n).args] : null);
    return { setposition: g('setposition'), seteuler: g('seteuler'), setscale: g('setscale') };
  }

  /** Writes a target's on-screen transform into its .n2 commands (only what changed). */
  writeBack(t) {
    const obj = this.objectOf(t);
    if (!t || !obj) return;
    if (t.spawn) {
      const a = t.spawn.args;
      const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
      a[2] = fmt(obj.position.x); a[3] = fmt(obj.position.y - 0.9); a[4] = fmt(obj.position.z);
      a[6] = fmt(e.y);
      this.applySpawn(obj); // spawns stay upright and unscaled
      return;
    }
    const n = t.node;
    const p = obj.position;
    n.setCmd('setposition', [fmt(p.x), fmt(p.y), fmt(p.z)], ['setlocalbox', 'setviewdistance']);
    const old = n.nums('seteuler') || [0, 0, 0];
    const e = eulerNear(obj.quaternion, old);
    if (n.cmd('seteuler') || e.some((v) => Math.abs(v) > 1e-4)) {
      // keep the original numbers when the rotation did not really change
      const same = old.every((v, i) => Math.abs(((v - e[i]) % 360 + 540) % 360 - 180) < 1e-3);
      if (!same) n.setCmd('seteuler', e.map(fmt), ['setposition']);
    }
    const sc = obj.scale;
    if (n.cmd('setscale') || Math.abs(sc.x - 1) > 1e-5 || Math.abs(sc.y - 1) > 1e-5 || Math.abs(sc.z - 1) > 1e-5) {
      n.setCmd('setscale', [fmt(sc.x), fmt(sc.y), fmt(sc.z)], ['seteuler', 'setposition']);
    }
  }

  /** World transform of a node as .n2 args (used when copying a part out of its parent). */
  worldTransformArgs(node) {
    const obj = this.objects.get(node.uid);
    if (!obj) return null;
    obj.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    obj.matrixWorld.decompose(p, q, s);
    return { setposition: [p.x, p.y, p.z].map(fmt), seteuler: eulerNear(q, node.nums('seteuler') || [0, 0, 0]).map(fmt), setscale: [s.x, s.y, s.z].map(fmt) };
  }

  /** Sets each selected object on the ground (its lowest point at terrain height). */
  dropToGround() {
    if (!this.level || !this.selection.length) return false;
    for (const t of this.selection) {
      const obj = this.objectOf(t);
      const wp = obj.getWorldPosition(new THREE.Vector3());
      const wantY = this.level.heightAt(wp.x, wp.z);
      const bottom = t.spawn ? wp.y - 0.9 : this.boxOf(obj).min.y;
      wp.y += wantY - bottom;
      obj.parent.worldToLocal(wp);
      obj.position.copy(wp);
    }
    if (this.selection.length > 1) this.placePivot();
    return true;
  }

  focusSelection() {
    if (!this.selection.length) return;
    this.updateSelectionBox();
    const b = this.selBox.box;
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(4, b.getSize(new THREE.Vector3()).length());
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, r * 1.6);
    this.orbit.update();
    this.invalidate();
  }

  /** A good spot to drop new objects: the terrain point under the screen centre. */
  dropPoint() {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    return this.terrainHit(this.raycaster.ray) || this.orbit.target.clone();
  }

  // ---------------------------------------------------------------- mouse

  _initPointer() {
    const el = this.renderer.domElement;
    let down = null;
    let painting = false;
    let lastPaint = 0;
    const rectEl = document.createElement('div');
    rectEl.className = 'selrect';
    rectEl.hidden = true;
    this.container.appendChild(rectEl);
    const ndc = (e) => {
      const r = el.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
      if (this.mode === 'select' && e.button === 0) el.setPointerCapture(e.pointerId);
      if (this.mode === 'terrain' && e.button === 0 && this.level?.terrain) {
        this.raycaster.setFromCamera(ndc(e), this.camera);
        const hit = this.terrainHit(this.raycaster.ray);
        if (hit && e.shiftKey) {
          this.brush.height = Number(hit.y.toFixed(3));
          this.dispatchEvent(new CustomEvent('brushheight', { detail: this.brush.height }));
          return;
        }
        if (hit) {
          painting = true;
          this.orbit.enabled = false;
          this._terrainBefore = this.level.terrain.heights.slice();
          this.applyBrush(hit, 1);
          lastPaint = performance.now();
          el.setPointerCapture(e.pointerId);
        }
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (down && this.mode === 'select' && down.button === 0) {
        const r = this.container.getBoundingClientRect();
        const x0 = Math.min(down.x, e.clientX) - r.left, y0 = Math.min(down.y, e.clientY) - r.top;
        Object.assign(rectEl.style, { left: x0 + 'px', top: y0 + 'px', width: Math.abs(e.clientX - down.x) + 'px', height: Math.abs(e.clientY - down.y) + 'px' });
        rectEl.hidden = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
        return;
      }
      if (!painting) return;
      const now = performance.now();
      if (now - lastPaint < 30) return;
      const dt = Math.min(3, (now - lastPaint) / 50);
      lastPaint = now;
      this.raycaster.setFromCamera(ndc(e), this.camera);
      const hit = this.terrainHit(this.raycaster.ray);
      if (hit) this.applyBrush(hit, dt);
    });
    el.addEventListener('pointerup', (e) => {
      if (painting) {
        painting = false;
        this.orbit.enabled = true;
        this.dispatchEvent(new CustomEvent('terrainpainted', { detail: { before: this._terrainBefore } }));
        this._terrainBefore = null;
        return;
      }
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      const button = down.button;
      const start = down;
      down = null;
      const additive = e.ctrlKey || e.shiftKey;
      if (button === 2) {
        // right-click without dragging: context menu (right-drag pans)
        if (moved) return;
        const hit = this.pickTarget(ndc(e), e.altKey);
        if (hit && !this.isSelected(hit)) this.select(hit);
        this.dispatchEvent(new CustomEvent('menu', { detail: { x: e.clientX, y: e.clientY } }));
        return;
      }
      if (button !== 0) return;
      if (this.mode === 'select' && moved) {
        rectEl.hidden = true;
        this.selectInRect(start, e, additive);
        return;
      }
      if (moved || this.gizmo.dragging || this.mode === 'terrain') return;
      if (this.gizmo.axis) return; // clicked the gizmo
      const hit = this.pickTarget(ndc(e), e.altKey);
      if (additive) { if (hit) this.toggleSelect(hit); }
      else this.select(hit);
    });
  }

  /** Selects the placed objects and spawn points whose centre is inside a screen rectangle. */
  selectInRect(a, b, additive) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x0 = Math.min(a.x, b.clientX), x1 = Math.max(a.x, b.clientX);
    const y0 = Math.min(a.y, b.clientY), y1 = Math.max(a.y, b.clientY);
    const inside = (wp) => {
      const p = wp.clone().project(this.camera);
      if (p.z < -1 || p.z > 1) return false;
      const sx = r.left + (p.x + 1) / 2 * r.width, sy = r.top + (1 - p.y) / 2 * r.height;
      return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
    };
    const found = [];
    for (const n of this.level.entities.children) {
      const obj = this.objects.get(n.uid);
      if (!obj || !obj.visible) continue;
      if (inside(this.boxOf(obj).getCenter(new THREE.Vector3()))) found.push({ node: n });
    }
    if (this.spawnGroup.visible) for (const m of this.spawnGroup.children) if (inside(m.position)) found.push({ spawn: m.userData.spawn });
    this.select(additive ? [...this.selection, ...found] : found);
  }

  /** What is under the mouse: a placed object (or the exact part), a spawn point, or null. */
  pickTarget(p, exact) {
    this.raycaster.setFromCamera(p, this.camera);
    const targets = [];
    if (this.spawnGroup.visible) targets.push(...this.spawnGroup.children);
    const models = this.viewMode !== 'boxes';
    for (const g of this.objects.values()) {
      if (!g.visible) continue;
      if (models && g.userData.modelMesh) targets.push(g.userData.modelMesh);
    }
    for (const pk of this.pickables) {
      if (models && pk.parent.userData.modelMesh) continue;
      targets.push(pk);
    }
    const visibleChain = (o) => { for (let x = o.parent; x; x = x.parent) if (!x.visible) return false; return true; };
    const hits = this.raycaster.intersectObjects(targets, false).filter((h) => visibleChain(h.object));
    // prefer models / small boxes the ray passes through: for proxies take the smallest box
    // among the first few hits, so clicking inside a big building's box can still reach crates
    let best = null;
    if (hits.length) {
      if (models || hits[0].object.userData.spawn) best = hits[0];
      else {
        const near = hits.filter((h) => h.distance < hits[0].distance + 30).slice(0, 8);
        best = near.reduce((a, h) => (h.object.scale.lengthSq() < a.object.scale.lengthSq() ? h : a));
      }
    }
    if (!best) return null;
    if (best.object.userData.spawn) return { spawn: best.object.userData.spawn };
    let node = best.object.parent.userData.node;
    if (!exact) while (node.parent && node.parent.parent && node.parent.name !== 'entities') node = node.parent;
    return { node };
  }

  setTerrainVisible(v) { this.terrainVisible = v; if (this.terrainMesh) this.terrainMesh.visible = v; this.invalidate(); }
  setSpawnsVisible(v) { this.spawnGroup.visible = v; this.invalidate(); }

  // ---------------------------------------------------------------- off-screen renders (level 3)

  async withTexturedScene(fn) {
    const prevMode = this.viewMode;
    const hidden = [this.gizmoHelper, this.selBox, this.spawnGroup].map((o) => [o, o.visible]);
    for (const [o] of hidden) o.visible = false;
    await this.setViewMode('textured');
    const waits = [];
    for (const m of this.texMats.values()) if (m.userData.ready) waits.push(m.userData.ready);
    if (this._terrainTex?.userData.ready) waits.push(this._terrainTex.userData.ready);
    await Promise.all(waits);
    const terrainWasVisible = this.terrainMesh?.visible;
    if (this.terrainMesh) this.terrainMesh.visible = true;
    const opacity = this.opacity ?? 1;
    if (opacity < 1) this.setOpacity(1); // minimaps and menu pictures are always solid
    try { return fn(); } finally {
      if (opacity < 1) this.setOpacity(opacity);
      for (const [o, v] of hidden) o.visible = v;
      if (this.terrainMesh) this.terrainMesh.visible = terrainWasVisible;
      await this.setViewMode(prevMode);
    }
  }

  renderToRgba(camera, w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
    const bg = this.scene.background;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, camera);
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    this.renderer.setRenderTarget(null);
    rt.dispose();
    this.scene.background = bg;
    // WebGL rows start at the bottom; DDS rows start at the top
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    this.invalidate();
    return out;
  }

  /** Top-down orthographic render of the square [x0, x0+size] x [z0, z0+size]; image top = smaller z. */
  renderTopView(x0, z0, size, px) {
    return this.withTexturedScene(() => {
      const cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 1, 3000);
      cam.position.set(x0 + size / 2, 1500, z0 + size / 2);
      cam.up.set(0, 0, -1);
      cam.lookAt(x0 + size / 2, 0, z0 + size / 2);
      cam.updateProjectionMatrix();
      return this.renderToRgba(cam, px, px);
    });
  }

  renderFromCamera(px) {
    return this.withTexturedScene(() => {
      const cam = this.camera.clone();
      cam.aspect = 1;
      cam.updateProjectionMatrix();
      return this.renderToRgba(cam, px, px);
    });
  }
}
