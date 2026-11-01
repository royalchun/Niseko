// Lifts, pistes and labels draped on the terrain (OpenStreetMap data, ODbL).
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RESORTS, PISTE_COLORS, SUMMIT, BC_AREAS } from './config.js';

const resortColor = id => RESORTS.find(r => r.id === id)?.color ?? '#94a3b8';

export function buildOverlays({ osm, terrain, onResortClick }) {
  const { frame, elevationAt } = terrain;
  const group = new THREE.Group();
  const pisteGroup = new THREE.Group(), offGroup = new THREE.Group(), liftGroup = new THREE.Group(), labelGroup = new THREE.Group(),
    liftLabelGroup = new THREE.Group(), runLabelGroup = new THREE.Group();
  group.add(pisteGroup, offGroup, liftGroup, labelGroup, liftLabelGroup, runLabelGroup);
  const materials = [];

  const lineMat = (color, width, opacity = 1, dash = null) => {
    const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthTest: true, ...(dash ? { dashed: true, dashSize: dash[0], gapSize: dash[1] } : {}) });
    m.resolution.set(innerWidth, innerHeight);
    materials.push(m);
    return m;
  };

  // Drape a lat/lon polyline on the terrain, densifying every ~6 m (5 m DEM).
  function drape(pts, lift) {
    const out = [];
    const local = pts.map(([lat, lon]) => frame.toLocal(lat, lon));
    for (let i = 0; i < local.length - 1; i++) {
      const a = local[i], b = local[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 6));
      for (let k = 0; k < n; k++) {
        const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
        out.push(x, elevationAt(x, z) + (lift ? 0 : 5), z);
      }
    }
    const l = local[local.length - 1];
    out.push(l.x, elevationAt(l.x, l.z) + (lift ? 0 : 5), l.z);
    return out;
  }

  // Pistes: coloured line on a contrasting casing (white for black runs, dark otherwise),
  // plus a run-name label shown when zoomed in. Ungroomed / off-piste routes are dashed orange.
  const named = new Set();
  for (const p of osm.pistes) {
    if (p.pts.length < 2) continue;
    const pos = drape(p.pts, false);
    const dark = p.diff === 'advanced' || p.diff === 'expert';
    const target = p.offpiste ? offGroup : pisteGroup;
    const casingGeo = new LineGeometry(); casingGeo.setPositions(pos);
    // Thin, light casing so the run colour stays dominant (white halo behind black runs).
    const casing = new Line2(casingGeo, p.offpiste ? lineMat('#0f172a', 5, 0.45) : dark ? lineMat('#ffffff', 6.5, 0.85) : lineMat('#0f172a', 6, 0.3));
    casing.renderOrder = 1;
    const g = new LineGeometry(); g.setPositions(pos);
    const line = new Line2(g, p.offpiste ? lineMat('#f59e0b', 3, 1, [14, 9]) : lineMat(PISTE_COLORS[p.diff] ?? PISTE_COLORS.unknown, 4, 1));
    if (p.offpiste) line.computeLineDistances();
    line.renderOrder = 2;
    line.userData = casing.userData = { kind: 'piste', resort: p.resort, name: p.name, diff: p.diff, offpiste: !!p.offpiste };
    target.add(casing, line);

    // One label per run name, at the middle of its longest segment.
    const key = `${p.name}|${p.resort}`;
    if (p.name && !named.has(key)) {
      named.add(key);
      const longest = osm.pistes.filter(q => q.name === p.name && q.resort === p.resort).sort((x, y) => y.pts.length - x.pts.length)[0];
      const [la, lo] = longest.pts[Math.floor(longest.pts.length / 2)];
      const q = frame.toLocal(la, lo);
      const el = document.createElement('div');
      el.className = `label run-label ${p.offpiste ? 'off' : ''}`;
      el.style.setProperty('--c', p.offpiste ? '#f59e0b' : dark ? '#e2e8f0' : PISTE_COLORS[p.diff] ?? '#9ca3af');
      el.textContent = p.offpiste ? `⚠ ${p.name}` : p.name;
      const obj = new CSS2DObject(el);
      obj.position.set(q.x, elevationAt(q.x, q.z) + 12, q.z);
      obj.userData.offpiste = !!p.offpiste;
      runLabelGroup.add(obj);
    }
  }

  // Backcountry zone names (approximate).
  for (const a of BC_AREAS) {
    const q = frame.toLocal(a.lat, a.lon);
    const el = document.createElement('div');
    el.className = 'label bc-label';
    el.textContent = `≈ ${a.name}`;
    const obj = new CSS2DObject(el);
    obj.position.set(q.x, elevationAt(q.x, q.z) + 30, q.z);
    obj.userData.offpiste = true;
    runLabelGroup.add(obj);
  }

  // Lifts: straight cable between terrain-anchored stations + towers.
  const towerGeo = new THREE.CylinderGeometry(1.2, 1.6, 1, 6);
  towerGeo.translate(0, 0.5, 0);
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.6, roughness: 0.4 });
  const stationGeo = new THREE.BoxGeometry(22, 10, 14);
  const lifts = [];
  for (const l of osm.lifts) {
    const a = frame.toLocal(...l.pts[0]), b = frame.toLocal(...l.pts[l.pts.length - 1]);
    const H = l.type === 'magic_carpet' ? 1 : 14;
    const ya = elevationAt(a.x, a.z) + H, yb = elevationAt(b.x, b.z) + H;
    const g = new LineGeometry();
    g.setPositions([a.x, ya, a.z, b.x, yb, b.z]);
    const mat = lineMat(resortColor(l.resort), l.type === 'gondola' ? 4.5 : 3.2);
    const line = new Line2(g, mat);
    line.userData = { kind: 'lift', ...l };
    liftGroup.add(line);

    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nT = Math.max(0, Math.floor(len / 160));
    for (let i = 1; i <= nT; i++) {
      const t = i / (nT + 1);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const ground = elevationAt(x, z), cable = ya + (yb - ya) * t;
      const tower = new THREE.Mesh(towerGeo, towerMat);
      tower.position.set(x, ground, z);
      tower.scale.y = Math.max(6, cable - ground);
      tower.castShadow = true;
      liftGroup.add(tower);
    }
    for (const [p, y] of [[a, ya], [b, yb]]) {
      if (l.type === 'magic_carpet') break;
      const st = new THREE.Mesh(stationGeo, new THREE.MeshStandardMaterial({ color: resortColor(l.resort), roughness: 0.6 }));
      st.position.set(p.x, y - H + 5, p.z);
      st.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      st.castShadow = true;
      liftGroup.add(st);
    }

    if (l.type !== 'magic_carpet') {
      const el = document.createElement('div');
      el.className = 'label lift-label';
      el.innerHTML = `<span class="dot" style="background:${resortColor(l.resort)}"></span>${l.name}<span class="q"></span>`;
      const obj = new CSS2DObject(el);
      obj.position.set((a.x + b.x) / 2, (ya + yb) / 2 + 20, (a.z + b.z) / 2);
      liftLabelGroup.add(obj);
      lifts.push({ data: l, line, mat, labelEl: el, base: resortColor(l.resort) });
    }
  }

  // Resort labels (clickable) with live weather badge.
  const resortLabels = {};
  for (const r of RESORTS) {
    const p = frame.toLocal(r.base.lat, r.base.lon);
    const el = document.createElement('button');
    el.className = 'label resort-label';
    el.style.setProperty('--c', r.color);
    el.innerHTML = `<strong>${r.name}</strong><span class="wx">…</span>`;
    el.addEventListener('click', e => { e.stopPropagation(); onResortClick?.(r.id); });
    const obj = new CSS2DObject(el);
    obj.position.set(p.x, elevationAt(p.x, p.z) + 120, p.z);
    labelGroup.add(obj);
    resortLabels[r.id] = el;
  }
  for (const pk of osm.peaks) {
    const p = frame.toLocal(pk.lat, pk.lon);
    if (Math.abs(p.x) > frame.width / 2 || Math.abs(p.z) > frame.depth / 2) continue;
    const el = document.createElement('div');
    el.className = 'label peak-label' + (Math.abs(pk.lat - SUMMIT.lat) < 0.002 ? ' main' : '');
    el.innerHTML = `▲ ${pk.name ?? 'Peak'} <small>${Math.round(pk.ele)} m</small>`;
    const obj = new CSS2DObject(el);
    obj.position.set(p.x, elevationAt(p.x, p.z) + 40, p.z);
    labelGroup.add(obj);
    if (el.classList.contains('main')) resortLabels.summit = el;
  }

  return {
    group, pisteGroup, offGroup, liftGroup, labelGroup, liftLabelGroup, runLabelGroup, resortLabels, lifts,
    setResolution(w, h) { for (const m of materials) m.resolution.set(w, h); },
    // Colour lifts by an estimated queue (or restore resort colours).
    paintQueues(fn) {
      for (const L of lifts) {
        const q = fn?.(L.data);
        L.mat.color.set(q ? q.color : L.base);
        L.labelEl.querySelector('.q').textContent = q ? ` · ${q.text}` : '';
      }
    },
  };
}
