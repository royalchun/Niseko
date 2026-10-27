// Terrain: stitches free elevation + satellite tiles into a 3D mesh with a
// physically-motivated snow-cover shader (depth by elevation, slope shedding).
import * as THREE from 'three';
import { TILES } from './config.js';
import { tileRange, makeFrame } from './geo.js';

function loadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Download every tile of a range into one canvas. onTile reports progress.
async function stitch(range, urlFn, onTile) {
  const { z, x0, x1, y0, y1 } = range;
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = nx * 256; canvas.height = ny * 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      jobs.push(loadImage(urlFn(z, x, y)).then(img => {
        if (img) ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256);
        onTile?.(!!img);
      }));
    }
  }
  await Promise.all(jobs);
  return canvas;
}

export async function buildTerrain({ quality, renderer, onProgress }) {
  const demRange = tileRange(quality.demZoom);
  // Imagery range = exactly the same ground area as the DEM range.
  const k = 2 ** (quality.imgZoom - quality.demZoom);
  const imgRange = { z: quality.imgZoom, x0: demRange.x0 * k, x1: (demRange.x1 + 1) * k - 1, y0: demRange.y0 * k, y1: (demRange.y1 + 1) * k - 1 };
  const total = (demRange.x1 - demRange.x0 + 1) * (demRange.y1 - demRange.y0 + 1) + (imgRange.x1 - imgRange.x0 + 1) * (imgRange.y1 - imgRange.y0 + 1);
  let done = 0, failed = 0;
  const tick = ok => { done++; if (!ok) failed++; onProgress?.(done / total, failed); };

  const [demCanvas, imgCanvas] = await Promise.all([stitch(demRange, TILES.dem, tick), stitch(imgRange, TILES.img, tick)]);
  const frame = makeFrame(demRange);

  // Decode Terrarium: h = R*256 + G + B/256 - 32768
  const W = demCanvas.width, H = demCanvas.height;
  const px = demCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  const heights = new Float32Array(W * H);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < W * H; i++) {
    const h = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    heights[i] = h < -100 ? 0 : h;
    if (heights[i] < minH) minH = heights[i];
    if (heights[i] > maxH) maxH = heights[i];
  }

  // Bilinear sample in metres of real elevation for local (x, z).
  function elevationAt(x, z) {
    const u = (x / frame.width + 0.5) * (W - 1), v = (z / frame.depth + 0.5) * (H - 1);
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(u))), y0 = Math.max(0, Math.min(H - 2, Math.floor(v)));
    const fx = Math.min(1, Math.max(0, u - x0)), fy = Math.min(1, Math.max(0, v - y0));
    const i = y0 * W + x0;
    return heights[i] * (1 - fx) * (1 - fy) + heights[i + 1] * fx * (1 - fy) + heights[i + W] * (1 - fx) * fy + heights[i + W + 1] * fx * fy;
  }

  const seg = Math.min(quality.segments, W - 1);
  const geo = new THREE.PlaneGeometry(frame.width, frame.depth, seg, Math.round(seg * frame.depth / frame.width));
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, elevationAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  // Satellite texture (downscale if larger than the GPU allows).
  const maxTex = renderer.capabilities.maxTextureSize;
  let texCanvas = imgCanvas;
  if (imgCanvas.width > maxTex || imgCanvas.height > maxTex) {
    const s = maxTex / Math.max(imgCanvas.width, imgCanvas.height);
    texCanvas = document.createElement('canvas');
    texCanvas.width = Math.floor(imgCanvas.width * s); texCanvas.height = Math.floor(imgCanvas.height * s);
    texCanvas.getContext('2d').drawImage(imgCanvas, 0, 0, texCanvas.width, texCanvas.height);
  }
  const tex = new THREE.CanvasTexture(texCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;

  const uniforms = {
    uDepthBase: { value: 0 },   // snow depth (m) at uElevBase
    uDepthTop: { value: 0 },    // snow depth (m) at uElevTop
    uElevBase: { value: 300 },
    uElevTop: { value: 1250 },
    uFresh: { value: 0 },       // 0..1 fresh snow in last 24 h (brightens)
    uWet: { value: 0 },         // 0..1 rain / melt (greys snow)
    uStylized: { value: 0 },    // 1 = hide satellite, use painted colours
    uExag: { value: 1 },
  };

  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowPos;\nvarying vec3 vSnowNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSnowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSnowNormal = normalize(objectNormal); // object space = real (unexaggerated) slope');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSnowPos; varying vec3 vSnowNormal;
uniform float uDepthBase, uDepthTop, uElevBase, uElevTop, uFresh, uWet, uStylized, uExag;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float hReal = vSnowPos.y / uExag;
float slope = 1.0 - clamp(vSnowNormal.y, 0., 1.);
if (uStylized > 0.5) {
  vec3 forest = mix(vec3(0.16,0.27,0.13), vec3(0.24,0.33,0.17), vnoise(vSnowPos.xz/40.));
  vec3 rock = vec3(0.42,0.39,0.34);
  diffuseColor.rgb = mix(forest, rock, clamp(smoothstep(950., 1250., hReal) + smoothstep(0.45, 0.7, slope), 0., 1.));
}
// Linear lapse of snow depth with elevation (extrapolated, clamped >= 0).
float t = (hReal - uElevBase) / max(1., uElevTop - uElevBase);
float depth = max(0., mix(uDepthBase, uDepthTop, t));
float n = vnoise(vSnowPos.xz / 18.) * 0.6 + vnoise(vSnowPos.xz / 4.) * 0.4;
float cover = smoothstep(0.0, 0.30, depth + (n - 0.5) * 0.12);
cover *= 1.0 - smoothstep(0.62, 0.85, slope);                // cliffs shed snow
float treeShow = mix(0.10, 0.02, smoothstep(0.3, 1.5, depth));   // trees still poke through
vec3 snow = mix(vec3(0.80,0.85,0.92), vec3(0.97,0.98,1.0), uFresh);
snow = mix(snow, vec3(0.62,0.64,0.66), uWet * 0.6);
float lum = dot(diffuseColor.rgb, vec3(0.299,0.587,0.114));
float darkForest = (1.0 - smoothstep(0.08, 0.25, lum)) * (1.0 - uStylized);
diffuseColor.rgb = mix(diffuseColor.rgb, snow * (0.92 + 0.08 * n), cover * (1.0 - treeShow - darkForest * 0.25));`);
  };
  // Make sure our patched program is cached separately.
  mat.customProgramCacheKey = () => 'niseko-snow-v1';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  // Downscaled imagery for the minimap.
  const mini = document.createElement('canvas');
  mini.width = 320; mini.height = Math.round(320 * frame.depth / frame.width);
  mini.getContext('2d').drawImage(imgCanvas, 0, 0, mini.width, mini.height);

  return {
    mesh, frame, uniforms, elevationAt, minH, maxH, failed, total, miniCanvas: mini,
    setExaggeration(e) { mesh.scale.y = e; uniforms.uExag.value = e; },
    setStylized(on) { uniforms.uStylized.value = on ? 1 : 0; mat.map = on ? null : tex; mat.needsUpdate = true; },
  };
}
