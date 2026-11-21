// 3D forest: low-poly Todomatsu firs and white birches placed wherever the aerial
// photo shows forest (kept off ski runs and lift lines). Trees catch snow on their
// upward faces after storms, birches lose their leaves in winter, and everything
// sways with the wind. Instanced in 800 m blocks so off-screen blocks are culled
// and distant blocks are thinned.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BLOCK = 800;

// Texture atlas. Top row: birch crowns (left = bare winter twigs, right = summer leaves).
// Bottom half: solid white for the untextured parts (trunks, fir foliage) — a large area
// so it stays opaque at every mip level and in the shadow pass.
function crownAtlas() {
  const S = 256, c = document.createElement('canvas');
  c.width = S * 2; c.height = S * 2;
  const g = c.getContext('2d');
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  function branch(x, y, len, ang, w, depth, leaves) {
    const x2 = x + Math.cos(ang) * len, y2 = y - Math.sin(ang) * len;
    g.strokeStyle = depth > 3 ? '#e8e4dc' : '#5b4a3e';
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    if (depth <= 0) {
      if (leaves) { g.fillStyle = `hsl(${85 + r() * 25}, 45%, ${32 + r() * 14}%)`; g.beginPath(); g.arc(x2, y2, 7 + r() * 7, 0, 7); g.fill(); }
      return;
    }
    const n = depth > 3 ? 3 : 2;
    for (let i = 0; i < n; i++) branch(x2, y2, len * (0.62 + r() * 0.15), ang + (r() - 0.5) * 1.3, Math.max(0.8, w * 0.68), depth - 1, leaves);
  }
  g.lineCap = 'round';
  for (const [ox, leaves] of [[0, false], [S, true]]) {
    g.save(); g.translate(ox, 0);
    branch(S / 2, S, S * 0.3, Math.PI / 2, 6, 6, leaves);
    g.restore();
  }
  g.fillStyle = '#fff'; g.fillRect(0, S, S * 2, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tag a part with a flat colour and a kind (0 trunk, 1 birch crown, 2 fir foliage).
// Parts without their own texture get UVs in the atlas's white half.
function part(geo, color, kind) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(new Array(n).fill(kind), 1));
  if (kind !== 1) g.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [0.5, 0.25]).flat(), 2));
  else { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5, 0.5 + uv.getY(i) * 0.5); } // top-left; shader shifts to leaves
  return g;
}

// Three crossed vertical planes = a cheap, convincing crown silhouette.
function crossedPlanes(w, h, y) {
  return mergeGeometries([0, 1, 2].map(i => new THREE.PlaneGeometry(w, h).rotateY(i * Math.PI / 3).translate(0, y, 0)));
}

// Unit-height models (scaled per instance to real tree height in metres).
function firGeometry() {
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.018, 0.028, 0.22, 4, 1, true).translate(0, 0.11, 0), '#4a3626', 0),
    part(new THREE.ConeGeometry(0.21, 0.56, 7, 1, true).translate(0, 0.42, 0), '#1f3d2b', 2),
    part(new THREE.ConeGeometry(0.15, 0.48, 7, 1, true).translate(0, 0.74, 0), '#24462f', 2),
  ]);
}
function birchGeometry() {
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.014, 0.022, 0.62, 5, 1, true).translate(0, 0.31, 0), '#e6e2d8', 0),
    part(crossedPlanes(0.75, 0.72, 0.62), '#ffffff', 1),
  ]);
}

function treeMaterial(uniforms, atlas) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true, map: atlas, alphaTest: 0.5, side: THREE.DoubleSide });
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float kind; varying float vKind; varying float vUp;
uniform float uTreeTime, uTreeWind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vKind = kind; vUp = normal.y;
#ifdef USE_INSTANCING
  vec3 ip = instanceMatrix[3].xyz;
  float sway = sin(uTreeTime * 1.7 + ip.x * 0.07 + ip.z * 0.05) * uTreeWind * position.y * position.y * 0.05;
  transformed.x += sway; transformed.z += sway * 0.6;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vKind; varying float vUp;
uniform float uTreeSnow, uTreeLeaf;`)
      .replace('#include <map_fragment>', `
{
  // Birch crowns: bare twigs in winter (left half of the atlas), leaves in summer (right half).
  vec2 tuv = vMapUv;
  if (vKind > 0.5 && vKind < 1.5) tuv.x += 0.5 * step(0.5, uTreeLeaf);
  diffuseColor *= texture2D(map, tuv);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 c = diffuseColor.rgb;
  // Snow settles on upward faces of fir tiers; birch twigs get a light dusting.
  float up = smoothstep(-0.15, 0.55, vUp);
  float snow = vKind > 1.5 ? uTreeSnow * up * 0.9 : vKind > 0.5 ? uTreeSnow * 0.35 : uTreeSnow * up * 0.25;
  diffuseColor.rgb = mix(c, vec3(0.93, 0.95, 1.0), snow);
}`);
  };
  mat.customProgramCacheKey = () => 'niseko-tree-v2';
  return mat;
}

export function buildTrees({ terrain, quality, exag = 1 }) {
  const { frame, elevationAt, forestAt } = terrain;
  const uniforms = { uTreeTime: { value: 0 }, uTreeWind: { value: 0 }, uTreeSnow: { value: 0 }, uTreeLeaf: { value: 0 } };
  const geos = [firGeometry(), birchGeometry()];
  const atlas = crownAtlas();
  const mat = treeMaterial(uniforms, atlas);
  // Shadows respect the twig cut-outs instead of casting solid squares.
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5, side: THREE.DoubleSide });
  const group = new THREE.Group();
  const blocks = new Map();
  const S = quality.treeSpacing;
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296); // deterministic: same forest every visit
  let count = 0;

  for (let z = -frame.depth / 2; z < frame.depth / 2; z += S) {
    for (let x = -frame.width / 2; x < frame.width / 2; x += S) {
      const px = x + rand() * S, pz = z + rand() * S;
      const f = forestAt(px, pz);
      const r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand();
      if (!f || f.forest < 0.15 || r1 > f.forest) continue;
      const h0 = elevationAt(px, pz);
      if (h0 > 1150) continue;                                    // above the tree line
      const e = 6;
      const slope = Math.hypot(elevationAt(px + e, pz) - elevationAt(px - e, pz), elevationAt(px, pz + e) - elevationAt(px, pz - e)) / (2 * e);
      if (slope > 0.8) continue;                                  // > ~38°: cliffs, no trees
      const fir = r2 < 0.2 + 0.55 * f.conifer;
      const stunt = 1 - 0.45 * THREE.MathUtils.smoothstep(h0, 850, 1100); // wind-stunted near the top
      const height = (fir ? 10 + r3 * 9 : 9 + r3 * 6) * stunt;
      const key = `${Math.floor(px / BLOCK)},${Math.floor(pz / BLOCK)}`;
      let B = blocks.get(key);
      if (!B) blocks.set(key, (B = { cx: (Math.floor(px / BLOCK) + 0.5) * BLOCK, cz: (Math.floor(pz / BLOCK) + 0.5) * BLOCK, items: [[], []] }));
      B.items[fir ? 0 : 1].push([px, pz, h0, height, r4 * Math.PI * 2, 0.8 + rand() * 0.4, 0.85 + rand() * 0.25]);
      count++;
    }
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  function fill(mesh, items, ex) {
    items.forEach(([x, z, h0, h, rot, w, tint], i) => {
      q.setFromAxisAngle(up, rot);
      m4.compose(pos.set(x, h0 * ex - 0.6, z), q, scl.set(h * w, h, h * w));
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  for (const B of blocks.values()) {
    B.parts = B.items.map((items, kind) => {
      if (!items.length) return null;
      // Shuffle so lowering mesh.count thins the block evenly.
      for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      const mesh = new THREE.InstancedMesh(geos[kind], mat, items.length);
      items.forEach((it, i) => mesh.setColorAt(i, col.setScalar(it[6])));
      fill(mesh, items, exag);
      mesh.castShadow = quality.treeShadows;
      mesh.customDepthMaterial = depthMat;
      mesh.receiveShadow = false;
      group.add(mesh);
      return { mesh, items };
    }).filter(Boolean);
  }

  let enabled = true;
  return {
    group, count, uniforms,
    setExaggeration(ex) { for (const B of blocks.values()) for (const { mesh, items } of B.parts) fill(mesh, items, ex); },
    setVisible(on) { enabled = on; group.visible = on; },
    /** Per frame: distance culling + thinning, wind and seasonal state. */
    update(camera, target, dt) {
      uniforms.uTreeTime.value = (uniforms.uTreeTime.value + dt) % 1000;
      if (!enabled) return;
      const camDist = camera.position.distanceTo(target);
      const far = quality.treeDist;
      // From the overview the trees are sub-pixel: the photo already shows the forest.
      group.visible = camDist < far * 1.6;
      if (!group.visible) return;
      for (const B of blocks.values()) {
        const d = Math.hypot(B.cx - camera.position.x, B.cz - camera.position.z);
        const vis = d < far + BLOCK;
        const keep = THREE.MathUtils.clamp(1 - (d - far * 0.45) / (far * 0.7), 0.25, 1);
        for (const { mesh } of B.parts) { mesh.visible = vis; mesh.count = Math.max(1, Math.round(mesh.instanceMatrix.count * keep)); }
      }
    },
    /** snow 0..1 (how white the crowns are), leaf 0..1 (birch leaves), wind 0..1. */
    setConditions({ snow, leaf, wind }) {
      uniforms.uTreeSnow.value = snow;
      uniforms.uTreeLeaf.value = leaf;
      uniforms.uTreeWind.value = wind;
    },
  };
}
