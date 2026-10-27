// Sky, sun, fog, clouds and falling snow / rain driven by the weather state.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { SUMMIT } from './config.js';

// Solar position (NOAA approximation) → { elevation, azimuth } in radians.
export function sunPosition(date, lat = SUMMIT.lat, lon = SUMMIT.lon) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 864e5 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  const la = lat * rad;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation: el, azimuth: az }; // azimuth from north, clockwise
}

function softTexture(size, inner = 0.0, outer = 0.5) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, size * inner, size / 2, size / 2, size * outer);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Six-armed dendrite snowflake drawn on a canvas (alpha only).
function dendriteTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  g.translate(r, r);
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  g.shadowColor = '#fff'; g.shadowBlur = size * 0.04;
  for (let a = 0; a < 6; a++) {
    g.save(); g.rotate((a * Math.PI) / 3);
    g.lineWidth = size * 0.045;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -r * 0.88); g.stroke();
    g.lineWidth = size * 0.03;
    for (const [t, l] of [[0.35, 0.22], [0.6, 0.17], [0.8, 0.1]]) {
      g.beginPath(); g.moveTo(0, -r * t); g.lineTo(-r * l, -r * (t + l * 0.9)); g.moveTo(0, -r * t); g.lineTo(r * l, -r * (t + l * 0.9)); g.stroke();
    }
    g.restore();
  }
  g.beginPath(); g.arc(0, 0, size * 0.07, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildEffects({ scene, renderer, terrain, quality }) {
  const { frame } = terrain;
  const span = Math.max(frame.width, frame.depth);

  // --- Sky & lights ---
  const sky = new Sky();
  sky.scale.setScalar(span * 20);
  scene.add(sky);
  const skyU = sky.material.uniforms;
  skyU.mieCoefficient.value = 0.005;
  skyU.mieDirectionalG.value = 0.8;

  const hemi = new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = quality.shadows;
  if (quality.shadows) {
    const sm = Math.min(quality.shadowMap ?? 4096, renderer.capabilities.maxTextureSize);
    sun.shadow.mapSize.set(sm, sm);
    const s = span * 0.6;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 10, far: span * 4 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 2;
  }
  scene.add(sun, sun.target);

  scene.fog = new THREE.FogExp2(0xc8d3df, 0.00002);
  const fogTarget = new THREE.Color(), bgTarget = new THREE.Color();

  // --- Clouds: soft billboard puffs at cloud-base altitude ---
  const puffTex = softTexture(128, 0.05, 0.5);
  const MAXC = 260;
  const cloudGeo = new THREE.BufferGeometry();
  const cpos = new Float32Array(MAXC * 3), cseed = new Float32Array(MAXC);
  for (let i = 0; i < MAXC; i++) {
    cpos[i * 3] = (Math.random() - 0.5) * span * 1.6;
    cpos[i * 3 + 1] = 0;
    cpos[i * 3 + 2] = (Math.random() - 0.5) * span * 1.6;
    cseed[i] = Math.random();
  }
  cloudGeo.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  cloudGeo.setAttribute('seed', new THREE.BufferAttribute(cseed, 1));
  const cloudMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uTex: { value: puffTex }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2() }, uBase: { value: 1500 }, uSpan: { value: span * 1.6 },
      uScale: { value: renderer.getPixelRatio() * innerHeight }, uOpacity: { value: 0.5 }, uColor: { value: new THREE.Color(1, 1, 1) }, uCount: { value: 0 } },
    vertexShader: `
      attribute float seed; uniform float uTime, uBase, uSpan, uScale, uCount; uniform vec2 uWind; varying float vA; varying float vSeed;
      void main(){
        vec3 p = position;
        p.xz = mod(p.xz + uWind * uTime + uSpan * 0.5, uSpan) - uSpan * 0.5;
        p.y = uBase + seed * 450.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = 900.0 + seed * 1400.0;
        gl_PointSize = min(2048.0, size * uScale / -mv.z * 0.5);
        vA = step(seed, uCount) * smoothstep(80.0, 600.0, -mv.z); vSeed = seed;
      }`,
    fragmentShader: `
      uniform sampler2D uTex; uniform float uOpacity; uniform vec3 uColor; varying float vA; varying float vSeed;
      void main(){ vec4 t = texture2D(uTex, gl_PointCoord); float a = t.a * uOpacity * vA; if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * (0.85 + 0.15 * vSeed), a); }`,
  });
  const clouds = new THREE.Points(cloudGeo, cloudMat);
  clouds.frustumCulled = false;
  clouds.renderOrder = 2;
  scene.add(clouds);

  // --- Precipitation ---
  // Three GPU-animated layers: "far" snow in a box that scales with zoom, "near"
  // big detailed flakes right around the camera, and ground-hugging spindrift.
  // Flakes read the terrain height texture so they stop where they hit the ground.
  const flakeTex = dendriteTexture(128);
  const terrainU = {
    uHeight: { value: terrain.heightTex }, uTerrain: { value: new THREE.Vector2(frame.width, frame.depth) }, uExag: { value: 1 },
  };
  const PRECIP_VS = `
    attribute float rnd; uniform float uTime, uBox, uScale, uRain, uSize, uFlutter, uGroundHug, uNearCut;
    uniform vec3 uCenter, uVel; uniform sampler2D uHeight; uniform vec2 uTerrain; uniform float uExag;
    varying float vR; varying float vFade; varying float vAngle; varying float vPx;
    float groundAt(vec2 xz){ vec2 uv = xz / uTerrain + 0.5; return texture2D(uHeight, uv).r * uExag; } // data row 0 = north = uv.y 0
    void main(){
      vec3 vel = uVel * (0.7 + 0.6 * rnd);
      vec3 p = position * uBox + vel * uTime;
      p.x += sin(uTime * (0.8 + rnd) + rnd * 40.0) * uBox * uFlutter * (1.0 - uRain);
      p.z += cos(uTime * (0.6 + rnd) + rnd * 20.0) * uBox * uFlutter * (1.0 - uRain);
      p = mod(p - uCenter + uBox * 0.5, uBox) + uCenter - uBox * 0.5;
      float g = groundAt(p.xz);
      if (uGroundHug > 0.5) p.y = g + 0.5 + rnd * rnd * 22.0 * uExag + sin(uTime * 3.0 + rnd * 50.0) * 2.0;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float s = uSize * (0.55 + 0.9 * rnd) * mix(1.0, 1.6, uRain);
      vPx = s * uScale / -mv.z;
      gl_PointSize = clamp(vPx, 1.0, 96.0);
      vR = rnd; vAngle = rnd * 6.2831 + uTime * (rnd - 0.5) * 1.5;
      vFade = (1.0 - smoothstep(uBox * 0.35, uBox * 0.5, length(p - uCenter))) * step(g, p.y)
        * smoothstep(uNearCut * 0.5, uNearCut, distance(p, cameraPosition)); // hand over to the near layer
    }`;
  const PRECIP_FS = `
    uniform float uRain, uOpacity, uLight; uniform sampler2D uFlake; uniform vec3 uTint;
    varying float vR; varying float vFade; varying float vAngle; varying float vPx;
    void main(){
      vec2 c = gl_PointCoord - 0.5;
      float ca = cos(vAngle), sa = sin(vAngle);
      vec2 rc = vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y);
      float dot_ = 1.0 - smoothstep(0.12, 0.5, length(c));
      float dendrite = texture2D(uFlake, rc + 0.5).a;
      float flake = mix(dot_, dendrite, smoothstep(10.0, 26.0, vPx));   // detail only when big on screen
      float streak = (1.0 - smoothstep(0.02, 0.08, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
      float a = mix(flake, streak * 0.55, uRain) * uOpacity * vFade;
      if (a < 0.02) discard;
      vec3 col = mix(vec3(1.0), vec3(0.75, 0.82, 0.92), uRain) * uTint * uLight;
      gl_FragColor = vec4(col, a);
    }`;
  function precipLayer(count, renderOrder) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3), rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) { pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random(); rnd[i] = Math.random(); }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uBox: { value: 600 }, uCenter: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -1.2, 0) },
        uScale: { value: renderer.getPixelRatio() * innerHeight }, uRain: { value: 0 }, uSize: { value: 1 }, uOpacity: { value: 0.9 },
        uFlutter: { value: 0.004 }, uGroundHug: { value: 0 }, uNearCut: { value: 0 }, uLight: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) },
        uFlake: { value: flakeTex }, ...terrainU,
      },
      vertexShader: PRECIP_VS, fragmentShader: PRECIP_FS,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = renderOrder;
    scene.add(pts);
    return { pts, geo, mat, count, u: mat.uniforms };
  }
  const far = precipLayer(quality.maxFlakes, 3);
  const near = precipLayer(quality.nearFlakes, 4);
  const drift = precipLayer(Math.round(quality.maxFlakes / 4), 3);
  near.u.uFlutter.value = 0.02;
  drift.u.uGroundHug.value = 1;
  drift.u.uFlutter.value = 0.01;
  const layers = [far, near, drift];

  let state = null, rate = 0, time = 0, driftLevel = 0, windStrength = 0, sunLight = 0;
  const windVec = new THREE.Vector2();

  function apply(s, date, exag) {
    state = s;
    // Sun & sky
    const { elevation, azimuth } = sunPosition(date);
    const dir = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    skyU.sunPosition.value.copy(dir);
    sun.position.copy(dir).multiplyScalar(span * 1.5);
    const cloud = (s.cloud ?? 0) / 100;
    const day = THREE.MathUtils.smoothstep(elevation, -0.12, 0.08);
    skyU.turbidity.value = 2 + cloud * 12;
    skyU.rayleigh.value = 1.2 + cloud * 2;
    sun.intensity = 2.6 * day * (1 - 0.8 * cloud);
    hemi.intensity = 0.15 + 0.85 * day * (1 - 0.3 * cloud);
    renderer.toneMappingExposure = 0.35 + 0.35 * day;
    const night = new THREE.Color(0x0b1220), overcast = new THREE.Color(0xb9c2cc).multiplyScalar(0.25 + 0.75 * day);
    sky.visible = cloud < 0.92 && day > 0.02;
    bgTarget.copy(day > 0.02 ? overcast : night);
    // Fog: visibility (m) → exp² density
    // Ground visibility is a point measurement; apply it softly so the aerial
    // view still shows the mountain through haze / snow.
    const vis = Math.max(2500, Math.min(40000, s.visibility ?? 24000));
    scene.fog.density = (0.45 / vis) * (1 + Math.min(1, (s.snowfall ?? 0) / 2));
    fogTarget.copy(overcast).lerp(new THREE.Color(0xeef2f7).multiplyScalar(0.3 + 0.7 * day), cloud * 0.5);

    // Clouds
    cloudMat.uniforms.uCount.value = Math.min(1, cloud * 1.05);
    cloudMat.uniforms.uOpacity.value = 0.12 + 0.3 * cloud;
    cloudMat.uniforms.uColor.value.setScalar(0.55 + 0.45 * day).multiplyScalar(1 - 0.25 * cloud * ((s.precip ?? 0) > 0.3 ? 1 : 0.4));
    const fz = s.freezing ?? 1500;
    cloudMat.uniforms.uBase.value = Math.max(700, Math.min(2200, (s.cloudLow ?? 0) > 60 ? 900 : fz * 0.9 + 400)) * exag;
    const wRad = ((s.windDir ?? 270) + 180) * Math.PI / 180; // direction the wind blows towards
    const wSpeed = (s.wind ?? 10) / 3.6; // m/s
    windVec.set(Math.sin(wRad), -Math.cos(wRad)).multiplyScalar(wSpeed);
    cloudMat.uniforms.uWind.value.copy(windVec).multiplyScalar(6); // time-lapse clouds

    // Precipitation
    const snowRate = s.snowfall ?? 0, rainRate = s.rain ?? 0;
    const isRain = rainRate > snowRate * 0.7 && rainRate > 0.05;
    rate = isRain ? Math.min(1, rainRate / 4) : Math.min(1, snowRate / 2.5); // cm/h → 0..1
    const any = snowRate > 0.02 || rainRate > 0.05;
    const fall = isRain ? 7 : 1.1;
    const light = 0.35 + 0.65 * day;
    for (const L of [far, near]) {
      L.geo.setDrawRange(0, any ? Math.round(L.count * (0.12 + 0.88 * rate)) : 0);
      L.u.uRain.value = isRain ? 1 : 0;
      L.u.uVel.value.set(windVec.x * (isRain ? 0.5 : 0.9), -fall, windVec.y * (isRain ? 0.5 : 0.9));
      L.u.uLight.value = light;
    }
    // Spindrift: strong gusts lift existing snow off the ground.
    const gust = s.top?.gust ?? s.gust ?? 0;
    const driftAmt = isRain ? 0 : THREE.MathUtils.clamp((gust - 35) / 40, 0, 1) * THREE.MathUtils.clamp((s.topDepth ?? 0) / 0.1, 0, 1);
    drift.geo.setDrawRange(0, Math.round(drift.count * driftAmt));
    drift.u.uVel.value.set(windVec.x * 1.8, 0, windVec.y * 1.8);
    drift.u.uOpacity.value = 0.35 + 0.4 * driftAmt;
    drift.u.uLight.value = light;
    driftLevel = driftAmt;
    windStrength = THREE.MathUtils.clamp(((s.wind ?? 0) - 10) / 40, 0, 1);
    sunLight = day * (1 - cloud);
  }

  function update(dt, camera, controls) {
    time += dt;
    cloudMat.uniforms.uTime.value = time;
    // Far box scales with zoom so it always reads as a snowstorm in view.
    const dist = camera.position.distanceTo(controls.target);
    const box = THREE.MathUtils.clamp(dist * 0.9, 250, 7000);
    far.u.uBox.value = box;
    far.u.uSize.value = box / 240;
    far.u.uTime.value = time * (box / 600); // keep apparent fall speed constant
    far.u.uCenter.value.copy(camera.position).lerp(controls.target, 0.45);
    far.u.uNearCut.value = Math.min(35, box * 0.1);
    // Near flakes: real-world scale around the camera (≈ 0.1 m flakes, 1 m/s).
    near.u.uBox.value = 70;
    near.u.uSize.value = 0.12;
    near.u.uTime.value = time;
    near.u.uCenter.value.copy(camera.position);
    const dbox = THREE.MathUtils.clamp(dist * 1.1, 300, 4000);
    drift.u.uBox.value = dbox;
    drift.u.uSize.value = dbox / 260;
    drift.u.uTime.value = time * (dbox / 600);
    drift.u.uCenter.value.copy(controls.target);
    scene.fog.color.lerp(fogTarget, Math.min(1, dt * 2));
    if (!scene.background) scene.background = new THREE.Color();
    scene.background.lerp(bgTarget, Math.min(1, dt * 2));
    sun.target.position.copy(controls.target);
  }

  function resize() {
    const s = renderer.getPixelRatio() * innerHeight;
    for (const L of layers) L.u.uScale.value = s;
    cloudMat.uniforms.uScale.value = s;
  }

  return {
    apply, update, resize,
    setVisible(on) { clouds.visible = on; for (const L of layers) L.pts.visible = on; },
    setExaggeration(e) { terrainU.uExag.value = e; },
    get rate() { return rate; }, get drift() { return driftLevel; }, get windStrength() { return windStrength; }, get sunLight() { return sunLight; },
    windTo: windVec,
  };
}
