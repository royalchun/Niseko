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
    sun.shadow.mapSize.set(4096, 4096);
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

  // --- Precipitation: GPU-animated points in a box that follows the camera ---
  const MAXP = quality.maxFlakes;
  const pGeo = new THREE.BufferGeometry();
  const ppos = new Float32Array(MAXP * 3), prnd = new Float32Array(MAXP);
  for (let i = 0; i < MAXP; i++) { ppos[i * 3] = Math.random(); ppos[i * 3 + 1] = Math.random(); ppos[i * 3 + 2] = Math.random(); prnd[i] = Math.random(); }
  pGeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
  pGeo.setAttribute('rnd', new THREE.BufferAttribute(prnd, 1));
  pGeo.setDrawRange(0, 0);
  const precipMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uBox: { value: 600 }, uCenter: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -1.2, 0) },
      uScale: { value: renderer.getPixelRatio() * innerHeight }, uRain: { value: 0 }, uSize: { value: 1 }, uOpacity: { value: 0.9 } },
    vertexShader: `
      attribute float rnd; uniform float uTime, uBox, uScale, uRain, uSize; uniform vec3 uCenter, uVel; varying float vR; varying float vFade;
      void main(){
        vec3 vel = uVel * (0.7 + 0.6 * rnd);
        vec3 p = position * uBox + vel * uTime;
        // flutter
        p.x += sin(uTime * (0.8 + rnd) + rnd * 40.0) * uBox * 0.004 * (1.0 - uRain);
        p.z += cos(uTime * (0.6 + rnd) + rnd * 20.0) * uBox * 0.004 * (1.0 - uRain);
        p = mod(p - uCenter + uBox * 0.5, uBox) + uCenter - uBox * 0.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float s = uSize * (0.6 + 0.8 * rnd) * mix(1.0, 1.6, uRain);
        gl_PointSize = clamp(s * uScale / -mv.z, 1.0, 64.0);
        vR = rnd; vFade = 1.0 - smoothstep(uBox * 0.35, uBox * 0.5, length(p - uCenter));
      }`,
    fragmentShader: `
      uniform float uRain, uOpacity; varying float vR; varying float vFade;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float flake = 1.0 - smoothstep(0.15, 0.5, length(c));
        float streak = (1.0 - smoothstep(0.02, 0.08, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
        float a = mix(flake, streak * 0.55, uRain) * uOpacity * vFade;
        if (a < 0.02) discard;
        gl_FragColor = vec4(mix(vec3(1.0), vec3(0.75, 0.82, 0.92), uRain), a);
      }`,
  });
  const precip = new THREE.Points(pGeo, precipMat);
  precip.frustumCulled = false;
  precip.renderOrder = 3;
  scene.add(precip);

  let state = null, rate = 0, time = 0;
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
    pGeo.setDrawRange(0, any ? Math.round(MAXP * (0.12 + 0.88 * rate)) : 0);
    precipMat.uniforms.uRain.value = isRain ? 1 : 0;
    const fall = isRain ? 7 : 1.1;
    precipMat.uniforms.uVel.value.set(windVec.x * (isRain ? 0.5 : 0.9), -fall, windVec.y * (isRain ? 0.5 : 0.9));
  }

  function update(dt, camera, controls) {
    time += dt;
    cloudMat.uniforms.uTime.value = time;
    // Precip box scales with zoom so it always looks like a snowstorm in view.
    const dist = camera.position.distanceTo(controls.target);
    const box = THREE.MathUtils.clamp(dist * 0.9, 250, 7000);
    const u = precipMat.uniforms;
    u.uBox.value = box;
    u.uSize.value = box / 220;
    u.uTime.value = time * (box / 600); // keep apparent fall speed constant
    u.uCenter.value.copy(camera.position).lerp(controls.target, 0.45);
    scene.fog.color.lerp(fogTarget, Math.min(1, dt * 2));
    if (!scene.background) scene.background = new THREE.Color();
    scene.background.lerp(bgTarget, Math.min(1, dt * 2));
    sun.target.position.copy(controls.target);
  }

  function resize() {
    const s = renderer.getPixelRatio() * innerHeight;
    precipMat.uniforms.uScale.value = s;
    cloudMat.uniforms.uScale.value = s;
  }

  return { apply, update, resize, setVisible(on) { precip.visible = clouds.visible = on; }, get rate() { return rate; } };
}
