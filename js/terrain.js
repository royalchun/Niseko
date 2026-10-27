// Terrain: stitches free elevation + aerial-photo tiles into chunked 3D meshes
// with a 5 m lighting (normal) map and a detailed snow-cover shader:
// depth by elevation, slope shedding, wind loading, sastrugi ripples, sparkle.
import * as THREE from 'three';
import { TILES } from './config.js';
import { tileRange, makeFrame, tx2lon, ty2lat, lon2tx, lat2ty } from './geo.js';

function loadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Try each URL builder in turn; resolves the first image that loads.
async function loadTile(urlFns, z, x, y) {
  for (const fn of urlFns) {
    const img = await loadImage(fn(z, x, y));
    if (img) return img;
  }
  return null;
}

// Decoders → metres. Return NaN for "no data".
const GSI_NODATA = 2 ** 23;
const decodeGSI = (r, g, b) => {
  const v = r * 65536 + g * 256 + b;
  if (v === GSI_NODATA) return NaN;
  return (v < GSI_NODATA ? v : v - 2 ** 24) * 0.01;
};
const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

function readPixels(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, 256, 256).data;
}

/**
 * Height grid at `demZoom` resolution. Base layer = GSI 10 m (z14), falling
 * back to AWS Terrarium per tile; at z15 the GSI 5 m DEM overrides wherever it
 * has data (it covers the whole Niseko range).
 */
async function loadHeights(range, tick) {
  const { z, x0, x1, y0, y1 } = range;
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const heights = new Float32Array(W * H).fill(NaN);
  const baseZ = Math.min(z, 14), s = 2 ** (z - baseZ);
  const bx0 = Math.floor(x0 / s), bx1 = Math.floor(x1 / s), by0 = Math.floor(y0 / s), by1 = Math.floor(y1 / s);

  // Base layer, bilinearly upsampled to the target grid.
  const baseJobs = [];
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    baseJobs.push((async () => {
      let img = await loadImage(TILES.demGSI10(baseZ, bx, by)), decode = decodeGSI;
      if (!img) { img = await loadImage(TILES.demAWS(baseZ, bx, by)); decode = decodeTerrarium; }
      tick(!!img);
      if (!img) return;
      const px = readPixels(img);
      const src = new Float32Array(256 * 256);
      for (let i = 0; i < src.length; i++) src[i] = decode(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      // Target pixels covered by this base tile.
      const gx0 = bx * 256 * s - x0 * 256, gy0 = by * 256 * s - y0 * 256;
      for (let ty = Math.max(0, gy0); ty < Math.min(H, gy0 + 256 * s); ty++) {
        const v = Math.min(255, Math.max(0, (ty - gy0 + 0.5) / s - 0.5));
        const r0 = Math.floor(v), r1 = Math.min(255, r0 + 1), fy = v - r0;
        for (let tx = Math.max(0, gx0); tx < Math.min(W, gx0 + 256 * s); tx++) {
          const u = Math.min(255, Math.max(0, (tx - gx0 + 0.5) / s - 0.5));
          const c0 = Math.floor(u), c1 = Math.min(255, c0 + 1), fx = u - c0;
          const a = src[r0 * 256 + c0], b = src[r0 * 256 + c1], c = src[r1 * 256 + c0], d = src[r1 * 256 + c1];
          heights[ty * W + tx] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        }
      }
    })());
  }
  await Promise.all(baseJobs);

  // 5 m detail layer.
  if (z === 15) {
    const jobs = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      jobs.push(loadImage(TILES.demGSI5(z, x, y)).then(img => {
        tick(true);
        if (!img) return;
        const px = readPixels(img);
        const ox = (x - x0) * 256, oy = (y - y0) * 256;
        for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) {
          const i = (r * 256 + c) * 4;
          const h = decodeGSI(px[i], px[i + 1], px[i + 2]);
          if (!Number.isNaN(h)) heights[(oy + r) * W + ox + c] = h;
        }
      }));
    }
    await Promise.all(jobs);
  }
  for (let i = 0; i < heights.length; i++) if (!(heights[i] > -100)) heights[i] = 0; // sea / gaps
  return { heights, W, H };
}

// ---------- Shared snow material ----------
function makeUniforms() {
  return {
    uDepthBase: { value: 0 },   // snow depth (m) at uElevBase
    uDepthTop: { value: 0 },    // snow depth (m) at uElevTop
    uElevBase: { value: 300 },
    uElevTop: { value: 1250 },
    uFresh: { value: 0 },       // 0..1 fresh snow in last 24 h (brightens)
    uWet: { value: 0 },         // 0..1 rain / melt (greys snow)
    uStylized: { value: 0 },    // 1 = hide aerial photo, use painted colours
    uExag: { value: 1 },
    uWindTo: { value: new THREE.Vector2(1, 0) }, // unit vector the wind blows toward (x, z)
    uWindStr: { value: 0 },     // 0..1
    uSparkle: { value: 0 },     // sunlit glitter strength
  };
}

const SNOW_COMMON = `
varying vec3 vSnowPos; varying vec3 vSnowNormal;
uniform float uDepthBase, uDepthTop, uElevBase, uElevTop, uFresh, uWet, uStylized, uExag, uWindStr, uSparkle;
uniform vec2 uWindTo;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
// Wind-aligned sastrugi / ripples (metres).
float ripple(vec2 q){
  vec2 w = normalize(uWindTo + 1e-4); vec2 pp = vec2(dot(q, w), dot(q, vec2(-w.y, w.x)));
  return vnoise(vec2(pp.x * 0.18, pp.y * 1.1)) * (0.15 + 0.35 * uWindStr) + vnoise(q * 0.9) * 0.08;
}`;

const SNOW_MAP = `
float hReal = vSnowPos.y / uExag;
#ifdef USE_NORMALMAP
  vec3 nObj = normalize(texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0);
#else
  vec3 nObj = normalize(vSnowNormal);
#endif
float slope = 1.0 - clamp(nObj.y, 0., 1.);
if (uStylized > 0.5) {
  vec3 forest = mix(vec3(0.16,0.27,0.13), vec3(0.24,0.33,0.17), vnoise(vSnowPos.xz/40.));
  vec3 rock = vec3(0.42,0.39,0.34);
  diffuseColor.rgb = mix(forest, rock, clamp(smoothstep(950., 1250., hReal) + smoothstep(0.45, 0.7, slope), 0., 1.));
}
// Linear lapse of depth with elevation, extrapolated, clamped >= 0.
float tE = (hReal - uElevBase) / max(1., uElevTop - uElevBase);
float depth = max(0., mix(uDepthBase, uDepthTop, tE));
// Wind loading: lee slopes (facing downwind) collect snow, windward ones get scoured.
float steep = length(nObj.xz);
float lee = steep > 0.01 ? dot(nObj.xz / steep, uWindTo) : 0.;
depth *= 1.0 + 0.5 * lee * smoothstep(0.05, 0.35, steep) * uWindStr;
float n = vnoise(vSnowPos.xz / 40.) * 0.45 + vnoise(vSnowPos.xz / 9.) * 0.35 + vnoise(vSnowPos.xz / 2.3) * 0.2;
float cover = smoothstep(0.0, 0.30, depth + (n - 0.5) * 0.14);
cover *= 1.0 - smoothstep(0.60, 0.85, slope);                     // cliffs shed snow
float treeShow = mix(0.10, 0.02, smoothstep(0.3, 1.5, depth));     // trees poke through
vec3 snowCol = mix(vec3(0.80,0.85,0.92), vec3(0.97,0.98,1.0), uFresh);
snowCol = mix(snowCol, vec3(0.62,0.64,0.66), uWet * 0.6);
float lum = dot(diffuseColor.rgb, vec3(0.299,0.587,0.114));
float darkForest = (1.0 - smoothstep(0.08, 0.25, lum)) * (1.0 - uStylized);
float snowCover = cover * (1.0 - treeShow - darkForest * 0.25 * (1.0 - 0.6 * uFresh));
diffuseColor.rgb = mix(diffuseColor.rgb, snowCol * (0.92 + 0.08 * n), snowCover);`;

const SNOW_NORMAL = `
{
  // Micro-relief of the snow surface, faded out with distance.
  float dCam = distance(cameraPosition, vSnowPos);
  float k = snowCover * (1.0 - smoothstep(250., 1800., dCam));
  if (k > 0.01) {
    float e = 0.7; vec2 q = vSnowPos.xz;
    float h0 = ripple(q), hx = ripple(q + vec2(e, 0.)), hz = ripple(q + vec2(0., e));
    vec3 dW = vec3(-(hx - h0) / e, 0., -(hz - h0) / e) * 0.9;
    normal = normalize(normal + (viewMatrix * vec4(dW, 0.)).xyz * k);
  }
}`;

const SNOW_EMISSIVE = `
{
  // View-dependent glitter on sunlit fresh snow.
  float dCam = distance(cameraPosition, vSnowPos);
  vec3 V = normalize(cameraPosition - vSnowPos);
  float g = hash12(floor(vSnowPos.xz * 1.6) + floor(V.xz * 45.0) * 7.13);
  float glint = smoothstep(0.993, 1.0, g) * snowCover * uSparkle * (1.0 - smoothstep(120., 900., dCam));
  totalEmissiveRadiance += vec3(glint * 4.0);
}`;

function makeSnowMaterial(uniforms, map, normalMap, extra = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap, normalMapType: THREE.ObjectSpaceNormalMap, roughness: 0.93, metalness: 0, ...extra,
  });
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowPos;\nvarying vec3 vSnowNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSnowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSnowNormal = normalize(objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SNOW_COMMON}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${SNOW_MAP}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, snowCover);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SNOW_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${SNOW_EMISSIVE}`);
  };
  mat.customProgramCacheKey = () => 'niseko-snow-v2';
  return mat;
}

// Object-space normal map: sample(i, j) gives the height at pixel (i, j) (it may be
// asked for one pixel outside the grid); dx, dz are the pixel spacing in metres.
function normalCanvas(sample, w, h, dx, dz) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const nx = -(sample(i + 1, j) - sample(i - 1, j)) / (2 * dx);
    const nz = -(sample(i, j + 1) - sample(i, j - 1)) / (2 * dz);
    const len = Math.hypot(nx, 1, nz);
    const o = (j * w + i) * 4;
    img.data[o] = ((nx / len) * 0.5 + 0.5) * 255;
    img.data[o + 1] = ((1 / len) * 0.5 + 0.5) * 255;
    img.data[o + 2] = ((nz / len) * 0.5 + 0.5) * 255;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function heightGeometry(width, depth, segX, segZ, cx, cz, elevationAt, lift = 0) {
  const geo = new THREE.PlaneGeometry(width, depth, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, elevationAt(pos.getX(i) + cx, pos.getZ(i) + cz) + lift);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export async function buildTerrain({ quality, renderer, onProgress }) {
  const demRange = tileRange(quality.demZoom);
  const k = 2 ** (quality.imgZoom - quality.demZoom);
  const nDx = demRange.x1 - demRange.x0 + 1, nDy = demRange.y1 - demRange.y0 + 1;
  // Chunks of up to 8×8 imagery tiles (2048 px textures work on every GPU).
  const chunkDem = Math.max(1, Math.floor(8 / k));
  const cols = Math.ceil(nDx / chunkDem), rows = Math.ceil(nDy / chunkDem);
  const baseTiles = Math.ceil(nDx / 2 ** (quality.demZoom - Math.min(14, quality.demZoom)) + 1) * Math.ceil(nDy / 2 ** (quality.demZoom - Math.min(14, quality.demZoom)) + 1);
  const total = baseTiles + (quality.demZoom === 15 ? nDx * nDy : 0) + nDx * nDy * k * k;
  let done = 0, failed = 0;
  const tick = ok => { done++; if (!ok) failed++; onProgress?.(Math.min(1, done / total), failed); };

  const frame = makeFrame(demRange);
  const imgSources = [TILES.imgGSI, TILES.imgEsri];

  // Imagery per chunk (loaded in parallel with the heights).
  const chunkImgs = [];
  const imgJobs = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const dx0 = demRange.x0 + c * chunkDem, dy0 = demRange.y0 + r * chunkDem;
    const ndx = Math.min(chunkDem, demRange.x1 - dx0 + 1), ndy = Math.min(chunkDem, demRange.y1 - dy0 + 1);
    const canvas = document.createElement('canvas');
    canvas.width = ndx * k * 256; canvas.height = ndy * k * 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#4b5a46'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    chunkImgs.push({ r, c, dx0, dy0, ndx, ndy, canvas });
    for (let y = 0; y < ndy * k; y++) for (let x = 0; x < ndx * k; x++) {
      imgJobs.push(loadTile(imgSources, quality.imgZoom, dx0 * k + x, dy0 * k + y).then(img => {
        if (img) ctx.drawImage(img, x * 256, y * 256);
        tick(!!img);
      }));
    }
  }

  const [{ heights, W, H }] = await Promise.all([loadHeights(demRange, tick), Promise.all(imgJobs)]);
  let minH = Infinity, maxH = -Infinity;
  for (const h of heights) { if (h < minH) minH = h; if (h > maxH) maxH = h; }

  // Bilinear sample (metres of real elevation) for local (x, z).
  function elevationAt(x, z) {
    const u = (x / frame.width + 0.5) * W - 0.5, v = (z / frame.depth + 0.5) * H - 0.5;
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(u))), y0 = Math.max(0, Math.min(H - 2, Math.floor(v)));
    const fx = Math.min(1, Math.max(0, u - x0)), fy = Math.min(1, Math.max(0, v - y0));
    const i = y0 * W + x0;
    return heights[i] * (1 - fx) * (1 - fy) + heights[i + 1] * fx * (1 - fy) + heights[i + W] * (1 - fx) * fy + heights[i + W + 1] * fx * fy;
  }

  const uniforms = makeUniforms();
  const group = new THREE.Group();
  const materials = [];
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const segPerDemTile = Math.max(8, Math.round(quality.segments / nDx));
  const mpt = frame.metersPerTile;

  for (const ch of chunkImgs) {
    const width = ch.ndx * mpt, depth = ch.ndy * mpt;
    const cx = -frame.width / 2 + (ch.dx0 - demRange.x0) * mpt + width / 2;
    const cz = -frame.depth / 2 + (ch.dy0 - demRange.y0) * mpt + depth / 2;
    const geo = heightGeometry(width, depth, ch.ndx * segPerDemTile, ch.ndy * segPerDemTile, cx, cz, elevationAt);
    // Normal map at native DEM resolution for this chunk.
    const px0 = (ch.dx0 - demRange.x0) * 256, py0 = (ch.dy0 - demRange.y0) * 256;
    const nW = ch.ndx * 256, nH = ch.ndy * 256;
    const hAt = (i, j) => heights[Math.min(H - 1, Math.max(0, py0 + j)) * W + Math.min(W - 1, Math.max(0, px0 + i))];
    const nTex = normalCanvas(hAt, nW, nH, width / nW, depth / nH);
    const tex = new THREE.CanvasTexture(ch.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = aniso;
    nTex.anisotropy = aniso;
    const mat = makeSnowMaterial(uniforms, tex, nTex);
    mat.userData.photo = tex;
    materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }

  // Downscaled imagery for the minimap.
  const mini = document.createElement('canvas');
  mini.width = 320; mini.height = Math.round(320 * frame.depth / frame.width);
  const mctx = mini.getContext('2d');
  for (const ch of chunkImgs) {
    const sx = mini.width / nDx, sy = mini.height / nDy;
    mctx.drawImage(ch.canvas, (ch.dx0 - demRange.x0) * sx, (ch.dy0 - demRange.y0) * sy, ch.ndx * sx, ch.ndy * sy);
  }

  // Height texture (for particles that hug / stop at the ground).
  const hw = 512, hh = Math.round(512 * H / W);
  const hdata = new Float32Array(hw * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) {
    hdata[j * hw + i] = elevationAt(((i + 0.5) / hw - 0.5) * frame.width, ((j + 0.5) / hh - 0.5) * frame.depth);
  }
  const heightTex = new THREE.DataTexture(hdata, hw, hh, THREE.RedFormat, THREE.FloatType);
  heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;
  heightTex.needsUpdate = true;

  // ---------- HD patch: sharper aerial photo around where you're looking ----------
  let patch = null, patchToken = 0;
  async function loadHDPatch(x, z) {
    const token = ++patchToken;
    const ll = frame.toLatLon(x, z);
    const pz = quality.hdZoom, n = quality.hdTiles;
    const tx0 = Math.floor(lon2tx(ll.lon, pz) - n / 2), ty0 = Math.floor(lat2ty(ll.lat, pz) - n / 2);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n * 256;
    const ctx = canvas.getContext('2d');
    const jobs = [];
    let ok = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      jobs.push(loadTile(imgSources, pz, tx0 + i, ty0 + j).then(img => { if (img) { ctx.drawImage(img, i * 256, j * 256); ok++; } }));
    }
    await Promise.all(jobs);
    if (token !== patchToken || ok < n * n * 0.8) return null;
    const nw = frame.toLocal(ty2lat(ty0, pz), tx2lon(tx0, pz));
    const se = frame.toLocal(ty2lat(ty0 + n, pz), tx2lon(tx0 + n, pz));
    const width = se.x - nw.x, depth = se.z - nw.z, cx = (nw.x + se.x) / 2, cz = (nw.z + se.z) / 2;
    const geo = heightGeometry(width, depth, 256, 256, cx, cz, elevationAt, 0.15);
    const res = 512;
    const nTex = normalCanvas((i, j) => elevationAt(nw.x + ((i + 0.5) / res) * width, nw.z + ((j + 0.5) / res) * depth), res, res, width / res, depth / res);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = aniso;
    const mat = makeSnowMaterial(uniforms, uniforms.uStylized.value ? null : tex, nTex, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.userData.photo = tex;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    if (patch) { group.remove(patch.mesh); disposeMesh(patch.mesh); materials.splice(materials.indexOf(patch.mesh.material), 1); }
    patch = { mesh, x: cx, z: cz, size: width };
    materials.push(mat);
    group.add(mesh);
    return patch;
  }
  function disposeMesh(m) {
    m.geometry.dispose();
    m.material.userData.photo?.dispose();
    m.material.normalMap?.dispose();
    m.material.dispose();
  }

  return {
    mesh: group, meshes: group.children, frame, uniforms, elevationAt, minH, maxH, failed, total, miniCanvas: mini, heightTex,
    loadHDPatch, get patch() { return patch; },
    setExaggeration(e) { group.scale.y = e; uniforms.uExag.value = e; },
    setStylized(on) {
      uniforms.uStylized.value = on ? 1 : 0;
      for (const m of materials) { m.map = on ? null : m.userData.photo; m.needsUpdate = true; }
    },
  };
}
