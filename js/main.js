import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { QUALITY, RESORTS, SUMMIT } from './config.js';
import { buildTerrain } from './terrain.js';
import { buildOverlays } from './overlays.js';
import { buildEffects } from './effects.js';
import { fetchHourly, fetchMultiModel, fetchEnsemble, fetchClimatology, sceneState, stateAt, wmo } from './weather.js';
import { analyse, renderChart } from './forecast.js';
import { estimateQueues, seasonInfo } from './crowd.js';

const $ = s => document.querySelector(s);
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

const qualityKey = store.get('nk-quality', matchMedia('(max-width: 820px)').matches ? 'balanced' : 'high');
const quality = QUALITY[qualityKey] ?? QUALITY.high;

// ---------- Renderer / scene ----------
const container = $('#scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = quality.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: 0, left: 0, pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 10, 400000);
const controls = new MapControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, screenSpacePanning: false, maxPolarAngle: Math.PI * 0.47, minDistance: 150, zoomToCursor: true, zoomSpeed: 1.2 });

// ---------- App state ----------
const app = {
  terrain: null, overlays: null, effects: null, weather: null, analysis: null,
  time: Date.now(), focus: null, demo: false, playing: false, exag: Number(store.get('nk-exag', 1.3)),
  times: [], queueOn: false,
};

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms);
}
const fmtTime = t => new Date(t).toLocaleString(undefined, { timeZone: 'Asia/Tokyo', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' JST';
const fmt = (v, d = 0, u = '') => (v == null || Number.isNaN(v) ? '—' : `${Number(v).toFixed(d).replace(/^-(0\.?0*)$/, '$1')}${u}`);
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg ?? 0) % 360) / 45) % 8];

// ---------- Camera helpers ----------
const anim = { active: false };
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function flyTo(target, position, ms = 1600) {
  Object.assign(anim, { active: true, t0: performance.now(), ms, fromT: controls.target.clone(), toT: target.clone(), fromP: camera.position.clone(), toP: position.clone() });
}
function elevAt(x, z) { return app.terrain ? app.terrain.elevationAt(x, z) * app.exag : 0; }

function viewFor(id) {
  const { frame } = app.terrain;
  if (id === 'overview' || !id) {
    const t = new THREE.Vector3(0, 500 * app.exag, -frame.depth * 0.05);
    return { target: t, pos: new THREE.Vector3(frame.width * 0.32, 6500 * app.exag, frame.depth * 0.78) };
  }
  if (id === 'summit') {
    const p = frame.toLocal(SUMMIT.lat, SUMMIT.lon);
    const t = new THREE.Vector3(p.x, elevAt(p.x, p.z), p.z);
    return { target: t, pos: t.clone().add(new THREE.Vector3(1300, 900, 1500)) };
  }
  const r = RESORTS.find(r => r.id === id);
  const b = frame.toLocal(r.base.lat, r.base.lon), top = frame.toLocal(r.top.lat, r.top.lon);
  const mid = new THREE.Vector3((b.x + top.x) / 2, 0, (b.z + top.z) / 2);
  mid.y = elevAt(mid.x, mid.z);
  const away = new THREE.Vector3(b.x - top.x, 0, b.z - top.z).normalize();
  const span = Math.hypot(b.x - top.x, b.z - top.z);
  const pos = mid.clone().addScaledVector(away, span * 1.25 + 900);
  pos.y = mid.y + span * 0.75 + 600;
  return { target: mid, pos };
}

function goTo(id, ms) {
  const v = viewFor(id);
  flyTo(v.target, v.pos, ms);
  app.focus = id === 'overview' || id === 'summit' ? (id === 'summit' ? 'summit' : null) : id;
  document.querySelectorAll('#resort-nav button').forEach(b => b.classList.toggle('active', b.dataset.go === id));
  refreshWeather();
  if (app.queueOn) renderQueues();
}

// Rotate / tilt / zoom programmatically around the current target.
function orbit(dAz, dPolar, zoomFactor = 1) {
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta += dAz;
  sph.phi = THREE.MathUtils.clamp(sph.phi + dPolar, 0.02, controls.maxPolarAngle);
  sph.radius = THREE.MathUtils.clamp(sph.radius * zoomFactor, controls.minDistance, 60000);
  const pos = new THREE.Vector3().setFromSpherical(sph).add(controls.target);
  flyTo(controls.target.clone(), pos, 450);
}
function pan(dx, dz) {
  const off = camera.position.clone().sub(controls.target);
  const dist = off.length();
  const fwd = new THREE.Vector3(-off.x, 0, -off.z).normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const move = right.multiplyScalar(dx * dist * 0.15).add(fwd.multiplyScalar(dz * dist * 0.15));
  flyTo(controls.target.clone().add(move), camera.position.clone().add(move), 300);
}

// ---------- Weather → scene ----------
function demoState(t) {
  const h = (t / 36e5) % 24;
  return {
    top: { temp: -11, snowfall: 3.2, wind: 28, windDir: 300, gust: 45, cloud: 100, visibility: 900, snow24: 42, snowDepth: 3.1, code: 75, elevation: 1250, freezing: 0 },
    bases: RESORTS.map(() => ({ temp: -6, snowfall: 2.4, snowDepth: 1.7, snow24: 35, elevation: 300, wind: 15, code: 75, visibility: 1200 })),
    baseDepth: 1.7, topDepth: 3.1, baseElev: 300, topElev: 1250, snowfall: 2.8 + Math.sin(h) * 0.6, rain: 0, temp: -8, wind: 28, windDir: 300,
    cloud: 100, cloudLow: 90, visibility: 900, snow24: 40, freezing: 0, demo: true,
  };
}

function currentState() {
  if (app.demo || !app.weather) return demoState(app.time);
  return sceneState(app.weather, app.time, app.focus);
}

function refreshWeather() {
  if (!app.terrain) return;
  const s = currentState();
  app.state = s;
  const u = app.terrain.uniforms;
  u.uDepthBase.value = s.baseDepth ?? 0;
  u.uDepthTop.value = s.topDepth ?? 0;
  u.uElevBase.value = s.baseElev ?? 300;
  u.uElevTop.value = s.topElev ?? 1250;
  u.uFresh.value = THREE.MathUtils.clamp((s.snow24 ?? 0) / 15, 0, 1);
  u.uWet.value = THREE.MathUtils.clamp((s.rain ?? 0) / 1.5 + ((s.temp ?? 0) > 2 ? 0.4 : 0), 0, 1);
  app.effects.apply(s, new Date(app.time), app.exag);
  updateConditions(s);
  updateResortBadges();
  const i = app.times.length ? nearestIndex(app.time) : 0;
  $('#tl').value = i;
  const diffH = Math.round((app.time - Date.now()) / 36e5);
  $('#tl-label').textContent = `${fmtTime(app.time)}${Math.abs(diffH) <= 1 ? ' · now' : diffH > 0 ? ` · +${diffH} h forecast` : ` · ${diffH} h past`}`;
  if (app.queueOn) paintQueues();
}

function updateConditions(s) {
  const f = s.focus ?? (app.focus === 'summit' ? s.top : null);
  const where = app.focus === 'summit' ? 'Summit · 1308 m' : app.focus ? `${RESORTS.find(r => r.id === app.focus).name} · base` : 'All Niseko United';
  const src = f ?? s.top;
  const [desc, icon] = wmo(src.code);
  $('#cond-where').textContent = where;
  $('#cond-time').textContent = fmtTime(app.time);
  $('#cond-icon').textContent = icon;
  const kind = (s.rain ?? 0) > (s.snowfall ?? 0) && (s.rain ?? 0) > 0.05 ? 'rain' : 'snow';
  $('#cond-desc').textContent = `${desc}${(s.snowfall ?? 0) > 0.05 && kind === 'snow' ? ` — ${s.snowfall.toFixed(1)} cm/h falling` : ''}`;
  $('#c-temp').textContent = f ? fmt(f.temp, 1, '°C') : `${fmt(s.bases[0]?.temp, 0)}° / ${fmt(s.top.temp, 0)}°C`;
  $('#c-snow').textContent = fmt(src.snowfall, 1, ' cm/h');
  $('#c-24').textContent = fmt(src.snow24, 0, ' cm');
  $('#c-wind').textContent = `${fmt(src.wind, 0)} km/h ${compass(src.windDir ?? s.windDir)}`;
  $('#c-base').textContent = fmt((s.baseDepth ?? 0) * 100, 0, ' cm');
  $('#c-top').textContent = fmt((s.topDepth ?? 0) * 100, 0, ' cm');
  $('#c-vis').textContent = src.visibility == null ? '—' : src.visibility >= 10000 ? `${Math.round(src.visibility / 1000)} km` : `${(src.visibility / 1000).toFixed(1)} km`;
  $('#c-frz').textContent = fmt(s.freezing ?? s.top.freezing, 0, ' m');
  $('#demo-banner').hidden = !app.demo;
}

function updateResortBadges() {
  const L = app.overlays?.resortLabels;
  if (!L) return;
  for (const r of RESORTS) {
    const st = app.demo ? demoState(app.time).bases[0] : app.weather ? stateAt(app.weather[r.id], app.time) : null;
    if (!st) continue;
    const [, icon] = wmo(st.code);
    L[r.id].querySelector('.wx').textContent = `${icon} ${fmt(st.temp, 0, '°')} · ${fmt((st.snowDepth ?? 0) * 100, 0, ' cm')} base${st.snow24 >= 1 ? ` · +${Math.round(st.snow24)} cm` : ''}`;
  }
}

// ---------- Timeline ----------
function nearestIndex(t) {
  const T = app.times;
  let best = 0;
  for (let i = 0; i < T.length; i++) if (Math.abs(T[i] - t) < Math.abs(T[best] - t)) best = i;
  return best;
}
function setupTimeline() {
  const T = app.weather.summit.time;
  app.times = T;
  const tl = $('#tl');
  tl.max = T.length - 1;
  tl.oninput = () => { app.time = T[Number(tl.value)]; refreshWeather(); };
  // Snowfall sparkline under the slider.
  const c = $('#tl-spark');
  const draw = () => {
    c.width = c.clientWidth * devicePixelRatio; c.height = 28 * devicePixelRatio;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const sf = app.weather.summit.snowfall, rn = app.weather.summit.rain;
    const max = Math.max(1.5, ...sf.map(v => v ?? 0));
    const w = c.width / T.length;
    const nowI = nearestIndex(Date.now());
    for (let i = 0; i < T.length; i++) {
      const h = ((sf[i] ?? 0) / max) * c.height * 0.9;
      g.fillStyle = i < nowI ? 'rgba(167,139,250,.75)' : 'rgba(56,189,248,.85)';
      g.fillRect(i * w, c.height - h, Math.max(1, w), h);
      if ((rn[i] ?? 0) > 0.1) { g.fillStyle = 'rgba(96,165,250,.35)'; g.fillRect(i * w, c.height - 3 * devicePixelRatio, Math.max(1, w), 3 * devicePixelRatio); }
      const d = new Date(T[i]);
      if (d.getUTCHours() === 15) { g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(i * w, 0, 1, c.height); } // JST midnight
    }
    g.fillStyle = '#fbbf24';
    g.fillRect(nowI * w - 1, 0, 2 * devicePixelRatio, c.height);
  };
  draw();
  addEventListener('resize', draw);
}

let playAcc = 0;
function togglePlay(on = !app.playing) {
  app.playing = on;
  $('#btn-play').textContent = on ? '❚❚' : '▶';
}

// ---------- Forecast panel ----------
async function loadForecast() {
  const [multi, ens, clim] = await Promise.allSettled([fetchMultiModel(), fetchEnsemble(), fetchClimatology()]);
  const val = r => (r.status === 'fulfilled' ? r.value : null);
  if (!val(multi) && !val(ens)) throw new Error(multi.reason?.message || 'Forecast unavailable');
  app.analysis = analyse({ multi: val(multi), ens: val(ens), clim: val(clim) });
  app.analysisNotes = [multi, ens, clim].map((r, i) => (r.status === 'rejected' ? ['Multi-model', 'Ensemble', 'Climatology'][i] : null)).filter(Boolean);
}

function renderForecastPanel() {
  const a = app.analysis;
  if (!a) { $('#fc-cards').innerHTML = '<div class="card">Loading forecast…</div>'; return; }
  const s = a.summary;
  const vsClim = s.clim7 > 0 ? Math.round((s.next7 / s.clim7) * 100) : null;
  $('#fc-cards').innerHTML = `
    <div class="card hot"><span>Next 3 days</span><b>${fmt(s.next3, 0)} cm</b></div>
    <div class="card"><span>Next 7 days</span><b>${fmt(s.next7, 0)} cm</b><small>${vsClim != null ? `${vsClim}% of normal` : ''}</small></div>
    <div class="card"><span>Next 16 days</span><b>${fmt(s.next16, 0)} cm</b></div>
    <div class="card"><span>30-day outlook</span><b>${fmt(s.next30, 0)} cm</b><small>avg ${fmt(s.clim30, 0)} cm</small></div>
    <div class="card"><span>Best powder day</span><b style="font-size:16px">${s.bestDay && s.bestDay.final >= 3 ? s.bestDay.label : 'None yet'}</b><small>${s.bestDay && s.bestDay.final >= 3 ? `${fmt(s.bestDay.final, 0)} cm · ${s.bestDay.quality.label}` : ''}</small></div>
    <div class="card"><span>Past 7 days</span><b>${fmt(s.past7, 0)} cm</b></div>`;
  if (app.analysisNotes?.length) $('#fc-cards').insertAdjacentHTML('beforeend', `<div class="card"><span>⚠️ Missing sources</span><small>${app.analysisNotes.join(', ')} (API limit?) — try again later</small></div>`);
  renderChart($('#fc-chart'), a);
  const rows = a.days.filter(d => !d.past).slice(0, 16);
  const max = Math.max(10, ...rows.map(d => d.final ?? 0));
  $('#fc-table').innerHTML = `<tr><th>Day</th><th>Snow</th><th>Range</th><th>≥10 cm</th><th>Temp</th><th>Gusts</th><th>Quality</th><th>Source</th></tr>` +
    rows.map(d => `<tr><td>${d.label}</td>
      <td><span class="snowbar" style="width:${Math.round(((d.final ?? 0) / max) * 60)}px"></span>${fmt(d.final, 0)} cm</td>
      <td>${d.low != null ? `${fmt(d.low, 0)}–${fmt(d.high, 0)}` : '—'}</td>
      <td>${d.prob10 != null ? Math.round(d.prob10 * 100) + '%' : '—'}</td>
      <td>${d.tmin != null ? `${fmt(d.tmin, 0)}° / ${fmt(d.tmax, 0)}°` : '—'}</td>
      <td>${fmt(d.gust, 0, ' km/h')}</td>
      <td><span class="stars">${'★'.repeat(d.quality.stars)}</span> ${d.quality.label}</td>
      <td><small>${d.source}</small></td></tr>`).join('');
}

// ---------- Queue panel ----------
const toLocalInput = t => new Date(t + 9 * 36e5).toISOString().slice(0, 16);
const fromLocalInput = v => Date.parse(v + ':00+09:00');
function queueTime() { return fromLocalInput($('#q-when').value); }
function queueWx(t) {
  if (app.demo) return { snow24: 40, gust: 45, temp: -9 };
  if (!app.weather) return {};
  const T = app.weather.summit.time;
  if (t < T[0] || t > T[T.length - 1]) {
    // Beyond forecast: use climatology as a "typical" powder estimate.
    const md = new Date(t + 9 * 36e5).toISOString().slice(5, 10);
    return { snow24: app.analysis?.days.find(d => d.date.slice(5) === md)?.clim ?? 0 };
  }
  const st = stateAt(app.weather.summit, t);
  return { snow24: st.snow24, gust: st.gust, temp: st.temp };
}
function paintQueues() {
  const est = estimateQueues(new Date(queueTime()), queueWx(queueTime()));
  app.overlays.paintQueues($('#q-map').checked && est.open ? l => est.lift(l) : null);
  return est;
}
function renderQueues() {
  const t = queueTime();
  const est = paintQueues();
  const s = seasonInfo(new Date(t));
  $('#q-reasons').innerHTML = `<b>${fmtTime(t)}</b> — ${est.open ? 'lifts operating' : 'closed'}${s.weekend ? ' · weekend/holiday' : ''}<br>${est.reasons.join(' · ') || 'Normal day'}`;
  if (!est.open) { $('#q-list').innerHTML = '<p class="muted">Pick a date in the ski season (late Nov – early May) and a time between 8:30 and 20:30 JST.</p>'; return; }
  const groups = RESORTS.map(r => {
    const items = app.overlays.lifts.filter(L => L.data.resort === r.id).map(L => ({ name: L.data.name, q: est.lift(L.data) })).filter(x => x.q)
      .sort((a, b) => (b.q.min ?? -1) - (a.q.min ?? -1));
    return `<div class="q-resort" style="--c:${r.color}"><h4>${r.name}</h4>${items.map(i => `<div class="q-item"><span>${i.name}</span><b style="color:${i.q.color}">${i.q.text}</b></div>`).join('')}</div>`;
  });
  $('#q-list').innerHTML = groups.join('');
}

// ---------- Panels & UI wiring ----------
function openPanel(id) {
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== id || !p.hidden;
  $('#btn-forecast').classList.toggle('on', !$('#panel-forecast').hidden);
  $('#btn-queue').classList.toggle('on', !$('#panel-queue').hidden);
  app.queueOn = !$('#panel-queue').hidden;
  if (!app.queueOn) app.overlays?.paintQueues(null);
  if (id === 'panel-forecast' && !$('#panel-forecast').hidden) renderForecastPanel();
  if (app.queueOn) {
    let t = app.time;
    if (!seasonInfo(new Date(t)).open) {
      // Off-season: suggest a typical busy Saturday morning in the season.
      t = Date.parse('2027-02-06T09:30:00+09:00');
      toast('Off-season now — showing a sample peak-season day. Change the date to plan your trip.', 3500);
    }
    $('#q-when').value = toLocalInput(t);
    renderQueues();
  }
}

function wireUI() {
  if (matchMedia('(max-width: 820px)').matches) $('#conditions').classList.add('collapsed');
  document.querySelectorAll('#resort-nav button').forEach(b => b.addEventListener('click', () => goTo(b.dataset.go)));
  $('#btn-forecast').onclick = () => openPanel('panel-forecast');
  $('#btn-queue').onclick = () => openPanel('panel-queue');
  $('#btn-layers').onclick = () => openPanel('panel-layers');
  $('#btn-help').onclick = () => openPanel('panel-help');
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => openPanel(null)));
  $('#btn-collapse-cond').onclick = () => $('#conditions').classList.toggle('collapsed');

  $('#q-when').onchange = renderQueues;
  $('#q-sync').onclick = () => { $('#q-when').value = toLocalInput(app.time); renderQueues(); };
  $('#q-map').onchange = renderQueues;

  const o = app.overlays;
  const bind = (id, fn) => { const el = $(id); el.onchange = () => fn(el.checked); fn(el.checked); };
  bind('#l-weather', on => app.effects.setVisible(on));
  bind('#l-pistes', on => (o.pisteGroup.visible = on));
  bind('#l-lifts', on => (o.liftGroup.visible = on));
  bind('#l-liftlabels', on => (app.liftLabels = on)); // per-label visibility handled in the render loop
  bind('#l-labels', on => o.labelGroup.children.forEach(c => (c.visible = on))); // CSS2D ignores parent visibility
  bind('#l-stylized', on => app.terrain.setStylized(on));
  $('#l-demo').onchange = e => { app.demo = e.target.checked; refreshWeather(); if (app.queueOn) renderQueues(); };
  const ex = $('#l-exag');
  ex.value = app.exag;
  $('#exag-val').textContent = `${app.exag.toFixed(1)}×`;
  ex.oninput = () => {
    const prev = app.exag;
    app.exag = Number(ex.value);
    $('#exag-val').textContent = `${app.exag.toFixed(1)}×`;
    store.set('nk-exag', app.exag);
    applyExag();
    const k = app.exag / prev;
    controls.target.y *= k; camera.position.y *= k;
    refreshWeather();
  };
  const qs = $('#l-quality');
  qs.innerHTML = Object.entries(QUALITY).map(([k, q]) => `<option value="${k}" ${k === qualityKey ? 'selected' : ''}>${q.label}</option>`).join('');
  qs.onchange = () => { store.set('nk-quality', qs.value); location.reload(); };
  $('#btn-shot').onclick = screenshot;

  $('#btn-play').onclick = () => togglePlay();
  $('#btn-now').onclick = () => { app.time = Date.now(); togglePlay(false); refreshWeather(); };
  $('#btn-share').onclick = share;

  // Nav pad
  const navs = {
    zoomin: () => orbit(0, 0, 0.6), zoomout: () => orbit(0, 0, 1.6),
    rotl: () => orbit(-Math.PI / 8, 0), rotr: () => orbit(Math.PI / 8, 0),
    tiltup: () => orbit(0, 0.18), tiltdown: () => orbit(0, -0.3), home: () => goTo('overview'),
  };
  document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => navs[b.dataset.nav]()));
  $('#compass').onclick = northUp;

  addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    const map = {
      arrowleft: () => pan(-1, 0), a: () => pan(-1, 0), arrowright: () => pan(1, 0), d: () => pan(1, 0),
      arrowup: () => pan(0, 1), w: () => pan(0, 1), arrowdown: () => pan(0, -1), s: () => pan(0, -1),
      q: navs.rotl, e: navs.rotr, r: navs.tiltup, f: navs.tiltdown, '+': navs.zoomin, '=': navs.zoomin, '-': navs.zoomout,
      n: northUp, 0: () => goTo('overview'), 1: () => goTo('annupuri'), 2: () => goTo('village'), 3: () => goTo('hirafu'), 4: () => goTo('hanazono'),
      ' ': () => togglePlay(), escape: () => openPanel(null),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  });

  // Hover tooltip + double-click fly-to
  const ray = new THREE.Raycaster();
  ray.params.Line2 = { threshold: 6 };
  const ndc = new THREE.Vector2();
  const pick = (ev, objs) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objs, false)[0];
  };
  renderer.domElement.addEventListener('dblclick', ev => {
    const hit = pick(ev, [app.terrain.mesh]);
    if (!hit) return;
    const off = camera.position.clone().sub(controls.target).multiplyScalar(0.5);
    if (off.length() < 400) off.setLength(400);
    flyTo(hit.point.clone(), hit.point.clone().add(off), 1000);
  });
  let hoverT = 0;
  renderer.domElement.addEventListener('pointermove', ev => {
    if (ev.buttons || performance.now() - hoverT < 60) return;
    hoverT = performance.now();
    const tip = $('#tooltip');
    const liftHit = o.liftGroup.visible ? pick(ev, o.lifts.map(l => l.line)) : null;
    const pisteHit = !liftHit && o.pisteGroup.visible && camera.position.distanceTo(controls.target) < 5000 ? pick(ev, o.pisteGroup.children) : null;
    let html = '';
    if (liftHit) {
      const d = liftHit.object.userData;
      const q = app.queueOn ? estimateQueues(new Date(queueTime()), queueWx(queueTime())).lift(d) : null;
      html = `<b>🚡 ${d.name}</b><br><small>${RESORTS.find(r => r.id === d.resort)?.name ?? 'Other area'} · ${d.type.replace('_', ' ')}</small>${q ? `<br>Est. queue: <b style="color:${q.color}">${q.text}</b>` : ''}`;
    } else if (pisteHit) {
      const d = pisteHit.object.userData;
      html = `<b>⛷️ ${d.name ?? 'Unnamed run'}</b><br><small>${d.diff} · ${RESORTS.find(r => r.id === d.resort)?.name ?? ''}</small>`;
    } else {
      const hit = pick(ev, [app.terrain.mesh]);
      if (hit && ev.shiftKey) {
        const ll = app.terrain.frame.toLatLon(hit.point.x, hit.point.z);
        const h = hit.point.y / app.exag;
        const s = app.state;
        const t = (h - s.baseElev) / Math.max(1, s.topElev - s.baseElev);
        const depth = Math.max(0, s.baseDepth + (s.topDepth - s.baseDepth) * t);
        html = `<b>${Math.round(h)} m</b> · ${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}<br>Est. snow depth: <b>${Math.round(depth * 100)} cm</b>`;
      }
    }
    tip.hidden = !html;
    if (html) { tip.innerHTML = html; tip.style.left = `${ev.clientX + 14}px`; tip.style.top = `${ev.clientY + 14}px`; }
  });
  renderer.domElement.addEventListener('pointerleave', () => ($('#tooltip').hidden = true));
  controls.addEventListener('start', () => { anim.active = false; });

  // Minimap
  const mm = $('#minimap');
  mm.width = app.terrain.miniCanvas.width; mm.height = app.terrain.miniCanvas.height;
  mm.addEventListener('click', ev => {
    const r = mm.getBoundingClientRect();
    const { frame } = app.terrain;
    const x = ((ev.clientX - r.left) / r.width - 0.5) * frame.width, z = ((ev.clientY - r.top) / r.height - 0.5) * frame.depth;
    const t = new THREE.Vector3(x, elevAt(x, z), z);
    const off = camera.position.clone().sub(controls.target);
    flyTo(t, t.clone().add(off), 900);
  });
}

function northUp() {
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta = 0;
  flyTo(controls.target.clone(), new THREE.Vector3().setFromSpherical(sph).add(controls.target), 600);
}

function drawMinimap() {
  const mm = $('#minimap');
  if (!mm.getClientRects().length) return; // hidden on phones
  const g = mm.getContext('2d');
  const { frame, miniCanvas } = app.terrain;
  g.drawImage(miniCanvas, 0, 0);
  const sx = mm.width / frame.width, sz = mm.height / frame.depth;
  const P = (x, z) => [(x + frame.width / 2) * sx, (z + frame.depth / 2) * sz];
  for (const r of RESORTS) {
    const p = frame.toLocal(r.base.lat, r.base.lon);
    const [x, y] = P(p.x, p.z);
    g.fillStyle = r.color; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    g.font = '600 11px Inter, sans-serif'; g.fillStyle = '#fff'; g.strokeStyle = '#000a'; g.lineWidth = 3;
    g.strokeText(r.short, x + 6, y + 4); g.fillText(r.short, x + 6, y + 4);
  }
  const [tx, ty] = P(controls.target.x, controls.target.z);
  const [cx, cy] = P(camera.position.x, camera.position.z);
  const dir = Math.atan2(ty - cy, tx - cx);
  const dist = camera.position.distanceTo(controls.target) * sx * 0.6;
  g.fillStyle = 'rgba(56,189,248,.25)'; g.strokeStyle = '#38bdf8'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(tx, ty);
  g.arc(tx, ty, Math.max(12, dist), dir + Math.PI - 0.45, dir + Math.PI + 0.45); g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(tx, ty, 3, 0, 7); g.fill();
}

// ---------- Share & screenshot ----------
function share() {
  const ll = app.terrain.frame.toLatLon(controls.target.x, controls.target.z);
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  const h = new URLSearchParams({ v: [ll.lat.toFixed(5), ll.lon.toFixed(5), Math.round(sph.radius), sph.theta.toFixed(3), sph.phi.toFixed(3)].join(','), t: Math.abs(app.time - Date.now()) > 2 * 36e5 ? Math.round(app.time / 36e5) : '' });
  if (app.focus) h.set('r', app.focus);
  if (app.demo) h.set('demo', 1);
  const url = `${location.origin}${location.pathname}#${h}`;
  history.replaceState(null, '', url);
  if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: 'Niseko Snow 3D', url }).catch(() => {});
  else navigator.clipboard?.writeText(url).then(() => toast('🔗 Link copied — send it to your friends!'), () => toast(url, 6000));
}
function restoreFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('demo')) { app.demo = true; $('#l-demo').checked = true; }
  if (h.get('t')) app.time = Number(h.get('t')) * 36e5;
  if (h.get('r')) app.focus = h.get('r');
  const v = h.get('v')?.split(',').map(Number);
  if (!v || v.length < 5 || v.some(Number.isNaN)) return false;
  const p = app.terrain.frame.toLocal(v[0], v[1]);
  const target = new THREE.Vector3(p.x, elevAt(p.x, p.z), p.z);
  const pos = new THREE.Vector3().setFromSpherical(new THREE.Spherical(v[2], v[4], v[3])).add(target);
  controls.target.copy(target); camera.position.copy(pos);
  return true;
}
function screenshot() {
  const prev = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.min(3, prev * 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.render(scene, camera);
  renderer.domElement.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `niseko-${new Date(app.time).toISOString().slice(0, 13)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    renderer.setPixelRatio(prev);
    renderer.setSize(innerWidth, innerHeight);
  });
}

function applyExag() {
  app.terrain.setExaggeration(app.exag);
  app.overlays.group.scale.y = app.exag;
}

// ---------- Main loop ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  if (anim.active) {
    const k = Math.min(1, (performance.now() - anim.t0) / anim.ms), e = ease(k);
    controls.target.lerpVectors(anim.fromT, anim.toT, e);
    camera.position.lerpVectors(anim.fromP, anim.toP, e);
    if (k >= 1) anim.active = false;
  }
  controls.update();
  // Keep the camera above ground and the target inside the model.
  if (app.terrain) {
    const { frame: f } = app.terrain;
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -f.width / 2, f.width / 2);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -f.depth / 2, f.depth / 2);
    const g = elevAt(camera.position.x, camera.position.z) + 40;
    if (camera.position.y < g) camera.position.y = g;
    if (!anim.active) controls.target.y += (elevAt(controls.target.x, controls.target.z) - controls.target.y) * 0.1;
  }
  if (app.playing && app.times.length) {
    playAcc += dt * Number($('#tl-speed').value);
    if (playAcc >= 1) {
      const i = nearestIndex(app.time) + Math.floor(playAcc);
      playAcc %= 1;
      app.time = app.times[i >= app.times.length ? 0 : i];
      refreshWeather();
    }
  }
  if (app.effects) app.effects.update(dt, camera, controls);
  // Compass needle
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  $('#needle').style.transform = `rotate(${-90 + (az * 180) / Math.PI}deg)`;
  // Hide lift labels when far away to avoid clutter.
  if (app.overlays) app.overlays.liftLabelGroup.children.forEach(o => (o.visible = (!!app.liftLabels || app.queueOn) && camera.position.distanceTo(o.position) < 4500));
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  if (app.terrain && (frame.n = (frame.n ?? 0) + 1) % 6 === 0) drawMinimap();
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  app.overlays?.setResolution(innerWidth, innerHeight);
  app.effects?.resize();
});

// ---------- Boot ----------
async function boot() {
  const msg = $('#loader-msg'), bar = $('#loader-bar');
  const weatherP = fetchHourly().catch(e => { console.warn('Weather failed', e); return null; });
  const osmP = fetch('data/niseko-osm.json').then(r => r.json());
  app.terrain = await buildTerrain({ quality, renderer, onProgress: (p, failed) => { bar.style.width = `${Math.round(p * 85)}%`; msg.textContent = `Downloading terrain & satellite tiles… ${Math.round(p * 100)}%${failed ? ` (${failed} failed)` : ''}`; } });
  scene.add(app.terrain.mesh);
  msg.textContent = 'Placing lifts & ski runs…';
  const osm = await osmP;
  app.overlays = buildOverlays({ osm, terrain: app.terrain, onResortClick: id => goTo(id) });
  scene.add(app.overlays.group);
  app.effects = buildEffects({ scene, renderer, terrain: app.terrain, quality });
  applyExag();
  msg.textContent = 'Fetching live weather…';
  bar.style.width = '92%';
  app.weather = await weatherP;
  if (!app.weather) toast('⚠️ Live weather unavailable right now (API limit or offline). Showing demo storm.', 5000);
  app.demo ||= !app.weather;
  $('#l-demo').checked = app.demo;

  const restored = restoreFromHash();
  if (!restored) { const v = viewFor('overview'); controls.target.copy(v.target); camera.position.copy(v.pos); }
  if (app.weather) setupTimeline();
  wireUI();
  refreshWeather();
  bar.style.width = '100%';
  $('#loader').classList.add('done');
  setTimeout(() => $('#loader').remove(), 800);
  if (!restored) setTimeout(() => goTo(app.focus ?? 'overview', 2200), 300);

  loadForecast().then(() => { if (!$('#panel-forecast').hidden) renderForecastPanel(); })
    .catch(e => { $('#fc-cards').innerHTML = `<div class="card">⚠️ Forecast unavailable: ${e.message}</div>`; });
}

requestAnimationFrame(frame);
boot().catch(e => {
  console.error(e);
  $('#loader-msg').textContent = `Something went wrong: ${e.message}. Try reloading.`;
});
